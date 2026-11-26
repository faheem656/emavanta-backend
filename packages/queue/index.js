import { randomUUID } from 'node:crypto';
import { QUEUE_NAMES } from '../shared/constants.js';
import { stableHash } from '../shared/utils.js';
import { nativeDatabase, isMemoryMode, dbInfo, isMongoUnavailable, noteMongoFailure, noteMongoSuccess } from '../database/store.js';

// Durable MongoDB queue: atomic claims with renewable leases, delayed jobs and
// bounded retries. Delivery is at-least-once, never exactly-once; handlers must
// still make their side effects idempotent. Memory mode is for local testing only.
const workers = new Set();
const queues = new Map();
const memoryQueues = new Map();
const memoryWorkers = new Map();
let indexes;
const POLL_MS = Math.max(100, Number(process.env.QUEUE_POLL_MS) || 2000);
// Shared across all worker lanes so a database outage does not cause a log or retry storm.
let outageUntil=0, outageFailures=0, outageLastLog=0, outageProbe=false, lastRateLog=0;
function queueUnavailable(e){
 if(!isMongoUnavailable(e)){const now=Date.now();if(now-outageLastLog>30000){outageLastLog=now;console.error('[queue] Queue operation unavailable. Check database connectivity and configuration.');}return;}
 noteMongoFailure(e);const now=Date.now();if(now>=outageUntil){outageFailures=Math.min(outageFailures+1,5);outageUntil=now+Math.min(30000,1000*2**outageFailures);}
 if(now-outageLastLog>30000){outageLastLog=now;console.error('[queue] Database unavailable; workers will retry with backoff. Jobs remain in MongoDB.');}
}
function queueRecovered(){noteMongoSuccess();if(outageFailures){outageFailures=0;outageUntil=0;outageLastLog=0;console.log('[queue] Database connection restored; workers resumed.');}}
const LEASE_MS = Math.max(5000, Number(process.env.QUEUE_LEASE_MS) || 60000);
function memQueue(name) { if (!memoryQueues.has(name)) memoryQueues.set(name, []); return memoryQueues.get(name); }
const jobs = () => nativeDatabase().collection('queue_jobs');
async function ensureIndexes() {
  if (!indexes) indexes = Promise.all([
    jobs().createIndex({ queue:1, state:1, availableAt:1 }),
    jobs().createIndex({ queue:1, state:1, leaseUntil:1 })
  ]).catch(e => { indexes = null; throw e; });
  return indexes;
}
const idFor = (queue, id) => stableHash('mongo-queue', queue, String(id));
const nowIso = () => new Date().toISOString();
const mapJob = row => ({ id:row.jobId, name:row.name, data:row.data, attempts:row.attempts, opts:row.opts });

function mongoQueue(name) {
  return {
    async add(jobName, data, opts = {}) {
      await ensureIndexes();
      const jobId = String(opts.jobId || stableHash(name,jobName,JSON.stringify(data)));
      const key = opts.dedupe === false && !opts.replace ? randomUUID() : idFor(name,jobId);
      const now = nowIso();
      const row = { _id:key, queue:name, jobId, name:jobName, data, opts,
        state:'waiting', attempts:0, availableAt:new Date(Date.now()+Math.max(0,Number(opts.delay)||0)).toISOString(),
        createdAt:now, updatedAt:now, leaseId:null, leaseUntil:null };
      if (opts.replace) {
        // A running pacer may schedule its own successor using the same ID. Resetting
        // the lease makes the old worker's acknowledgement incapable of deleting it.
        await jobs().replaceOne({ _id:key }, row, { upsert:true });
        return mapJob(row);
      }
      try { await jobs().insertOne(row); return mapJob(row); }
      catch (e) {
        if (e.code !== 11000) throw e;
        if (opts.retryFailed) {
          const revived=await jobs().findOneAndUpdate({_id:key,state:'failed'},{$set:{state:'waiting',attempts:0,availableAt:now,updatedAt:now,lastError:null}},{returnDocument:'after'});
          if(revived)return mapJob(revived);
        }
        const old=await jobs().findOne({ _id:key }); if (!old) throw e; return mapJob(old);
      }
    },
    async getJobCounts() {
      await ensureIndexes();
      const states=['waiting','active','failed','completed'];
      const counts=await Promise.all(states.map(state=>jobs().countDocuments({queue:name,state})));
      return Object.fromEntries(states.map((state,i)=>[state,counts[i]]));
    },
    async getWaiting() { await ensureIndexes(); return (await jobs().find({queue:name,state:'waiting'}).sort({availableAt:1}).limit(100).toArray()).map(mapJob); }
  };
}
// Delayed memory jobs live here until their timer fires: hasPendingJob must see
// them, and a `replace` re-arm must cancel the old timer (mongo replace overwrites
// the row; the memory driver has to mirror that or a pacer's successor stacks up).
const memoryDelayed = new Map();
function memoryQueue(name) {
  return {
    async add(jobName, data, opts = {}) {
      const id=opts.jobId||stableHash(name,jobName,JSON.stringify(data));
      const key=`${name}:${id}`;
      const existing=memQueue(name).find(j=>j.id===id&&j.attempts<(j.opts.attempts||4))
        || (memoryDelayed.get(key)?.job || null);
      if(existing){
        if(!opts.replace&&opts.dedupe!==false)return existing;
        const at=memQueue(name).indexOf(existing);if(at>=0)memQueue(name).splice(at,1);
        const pending=memoryDelayed.get(key);if(pending){clearTimeout(pending.timer);memoryDelayed.delete(key);}
      }
      const job={id,name:jobName,data,opts,attempts:0};
      const enqueue=()=>{memoryDelayed.delete(key);memQueue(name).push(job);const worker=memoryWorkers.get(name);if(worker)setTimeout(()=>worker.process(job),0);};
      if(opts.delay>0){const timer=setTimeout(enqueue,opts.delay);memoryDelayed.set(key,{timer,job});}
      else enqueue();
      return job;
    },
    async getJobCounts(){
      const delayed=[...memoryDelayed.keys()].filter(k=>k.startsWith(`${name}:`)).length;
      return {waiting:memQueue(name).length+delayed,active:0,failed:0,completed:0};
    },
    async getWaiting(){
      return [...memQueue(name),
        ...[...memoryDelayed.entries()].filter(([k])=>k.startsWith(`${name}:`)).map(([,v])=>v.job)];
    }
  };
}
export const getQueue = name => {
  if (!QUEUE_NAMES.includes(name)) throw new Error(`Unknown queue ${name}`);
  const mode=isMemoryMode()?'memory':'mongo', key=`${mode}:${name}`;
  if(!queues.has(key))queues.set(key,mode==='mongo'?mongoQueue(name):memoryQueue(name));
  return queues.get(key);
};

function mongoWorker(name, processor) {
  let stopped=false, timer, running=false;
  const tick=async()=>{
    if(stopped||running)return;
    if(Date.now()<outageUntil||outageProbe){timer=setTimeout(tick,Math.max(500,outageUntil-Date.now())+Math.floor(Math.random()*1000));timer.unref?.();return;}
    const probing=outageFailures>0;if(probing)outageProbe=true;
    running=true;
    try {
      await ensureIndexes();
      const leaseId=randomUUID(), now=nowIso();
      const job=await jobs().findOneAndUpdate({queue:name,$or:[
        {state:'waiting',availableAt:{$lte:now}}, {state:'active',leaseUntil:{$lte:now}}
      ]},{$set:{state:'active',leaseId,leaseUntil:new Date(Date.now()+LEASE_MS).toISOString(),updatedAt:now},$inc:{attempts:1}},
      {sort:{availableAt:1,createdAt:1},returnDocument:'after'});
      queueRecovered();
      if(job){
        const filter={_id:job._id,state:'active',leaseId};
        const max=Math.max(1,Math.min(20,Number(job.opts?.attempts)||4));
        if(job.attempts>max){await jobs().updateOne(filter,{$set:{state:'failed',lastError:'Lease expired too many times',updatedAt:nowIso()}});}
        else {
          const heartbeat=setInterval(()=>{void jobs().updateOne(filter,{$set:{leaseUntil:new Date(Date.now()+LEASE_MS).toISOString()}}).catch(()=>{});},Math.max(1000,Math.floor(LEASE_MS/3)));
          heartbeat.unref?.();
          try {
            await processor(job.data,mapJob(job));
            await jobs().updateOne(filter,{$set:{state:'completed',completedAt:nowIso(),updatedAt:nowIso(),leaseUntil:null}});
          } catch(e) {
            // A Redis outage must not consume finite job attempts or permit an unthrottled send.
            if(['UPSTASH_UNAVAILABLE','UPSTASH_CONFIG'].includes(e?.code)){
              const delay=Math.max(5000,Math.min(300000,Number(process.env.RATE_RETRY_DELAY_MS)||30000));
              await jobs().updateOne(filter,{$set:{state:'waiting',attempts:Math.max(0,job.attempts-1),availableAt:new Date(Date.now()+delay).toISOString(),lastError:'RATE_LIMIT_SERVICE_UNAVAILABLE',updatedAt:nowIso(),leaseUntil:null}});
              const now=Date.now();if(now-lastRateLog>30000){lastRateLog=now;console.error('[queue] Rate-limit service unavailable; sending remains paused and jobs will retry.');}
            } else {
              const failed=job.attempts>=max, delay=Math.min(300000,2000*2**Math.min(job.attempts-1,7));
              await jobs().updateOne(filter,{$set:{state:failed?'failed':'waiting',availableAt:new Date(Date.now()+delay).toISOString(),
                lastError:String(e?.code||'JOB_FAILED').slice(0,100),updatedAt:nowIso(),leaseUntil:null}});
              console.error(`[queue] ${name} ${failed?'failed':'retrying'} (${String(e?.code||'JOB_FAILED').slice(0,40)})`);
            }
          } finally {clearInterval(heartbeat);}
        }
      }
    }catch(e){queueUnavailable(e);}
    finally{if(probing)outageProbe=false;running=false;if(!stopped){timer=setTimeout(tick,POLL_MS);timer.unref?.();}}
  };
  timer=setTimeout(tick,0);timer.unref?.();
  const worker={async close(){stopped=true;clearTimeout(timer);while(running)await new Promise(r=>setTimeout(r,20));workers.delete(worker);}};
  workers.add(worker);return worker;
}
export const registerWorker = (name, processor) => {
  if(!QUEUE_NAMES.includes(name))throw new Error(`Unknown queue ${name}`);
  if(!isMemoryMode()) {
    const concurrency=Math.max(1,Math.min(16,Number(process.env.WORKER_CONCURRENCY)||1));
    const lanes=Array.from({length:concurrency},()=>mongoWorker(name,processor));
    return { close:async()=>{await Promise.all(lanes.map(lane=>lane.close()));} };
  }
  memoryWorkers.set(name,{process:async job=>{
    try{await processor(job.data,job);const q=memQueue(name);const i=q.indexOf(job);if(i>=0)q.splice(i,1);}
    catch(err){job.attempts++;if(job.attempts>=(job.opts.attempts||4)){const q=memQueue(name);const i=q.indexOf(job);if(i>=0)q.splice(i,1);}else{const t=setTimeout(()=>memoryWorkers.get(name)?.process(job),2000*2**(job.attempts-1));t.unref?.();}}
  }});
  return {close:async()=>memoryWorkers.delete(name)};
};
export const publishOutbox = async event => {await getQueue(event.queue||'outbox').add(event.type,event.payload,{jobId:stableHash('outbox',event._id||event.id)});return true;};

/**
 * True when a job with this id is waiting (delayed or due) or active. Used by the
 * scheduler sweep to revive a dead pacer without resetting a healthy one's delay —
 * re-arming a delayed pacer on every sweep would collapse the human gap to the
 * sweep interval.
 */
export const hasPendingJob = async (name, jobId) => {
  if (!QUEUE_NAMES.includes(name)) return false;
  if (isMemoryMode()) {
    const id = String(jobId);
    return memQueue(name).some(j => j.id === id) || memoryDelayed.has(`${name}:${id}`);
  }
  try {
    await ensureIndexes();
    const row = await jobs().findOne({ _id: idFor(name, String(jobId)), state: { $in: ['waiting', 'active'] } });
    return !!row;
  } catch (e) {
    queueUnavailable(e);
    return true; // cannot prove the job is dead — do not risk a duplicate pacer
  }
};
export const queueReadiness = async () => {const info=dbInfo();return {driver:info.driver==='mongo'?'mongo':'memory',ready:info.driver==='mongo'&&info.connected,durable:info.driver==='mongo'&&info.connected};};
export const closeQueues = async () => {await Promise.allSettled([...workers].map(w=>w.close()));queues.clear();indexes=null;outageUntil=0;outageFailures=0;outageLastLog=0;outageProbe=false;};
