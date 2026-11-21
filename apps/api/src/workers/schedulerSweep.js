import { expireCryptoAddons, expireCryptoSubscription } from '../payments/crypto-service.js';
import { isMemoryMode } from '../../../../packages/database/store.js';
import { collection } from '../../../../packages/database/store.js';
import { getQueue } from '../../../../packages/queue/index.js';
import { sweepStripe } from '../payments/stripe-service.js';

// A periodic sweep supplies the long-horizon poller after restarts. Claims expire
// so a crash between claiming and queueing does not strand scheduled rows forever.
export async function sweepScheduledJobs() {
  if(!isMemoryMode()){
    const due=await collection('crypto_addon_grants').find({status:'active',expiresAt:{$lte:new Date().toISOString()}},{limit:200});
    for(const id of new Set(due.map(x=>x.organizationId).filter(Boolean)))await expireCryptoAddons(id);
    const expiredPlans=await collection('organizations').find({planChangeSource:{$in:['crypto','stripe','platform_manual_override']},planExpiresAt:{$lte:new Date().toISOString(),$ne:null}},{limit:200});
    for(const org of expiredPlans) await expireCryptoSubscription(org._id);
  }
  const pendingEvents=await collection('outbox_events').find({status:'pending'},{limit:500});
  for(const event of pendingEvents) await getQueue('outbox').add('outbox.publish',{eventId:event._id},{jobId:`outbox-${event._id}`,retryFailed:true});
  const jobs=collection('scheduled_jobs'), now=new Date().toISOString();
  await jobs.updateMany({status:'claimed',leaseUntil:{$lte:now}},{$set:{status:'pending'}});
  const due=await jobs.find({status:'pending',runAt:{$lte:now}},{limit:500});
  for(const organizationId of new Set(due.map(row=>row.organizationId).filter(Boolean))) {
    await getQueue('scheduler').add('scheduler.poll',{organizationId,poll:true},{jobId:`poll-${organizationId}`,dedupe:false});
  }
  return due.length;
}
export function startSchedulerSweep(){
  let stopped=false, schedulerBusy=false, stripeBusy=false;
  const runScheduler=async()=>{if(stopped||schedulerBusy)return;schedulerBusy=true;try{await sweepScheduledJobs();}catch(e){console.error('[scheduler] sweep failed',String(e?.code||'SCHEDULER_ERROR'));}finally{schedulerBusy=false;}};
  const runStripe=async()=>{if(stopped||stripeBusy)return;stripeBusy=true;try{await sweepStripe();}catch(e){console.error('[payments] sweep unavailable',String(e?.code||'PAYMENT_ERROR'));}finally{stripeBusy=false;}};
  const schedulerTimer=setInterval(runScheduler,30000), stripeTimer=setInterval(runStripe,30000);
  schedulerTimer.unref?.();stripeTimer.unref?.();void runScheduler();void runStripe();
  return async()=>{stopped=true;clearInterval(schedulerTimer);clearInterval(stripeTimer);while(schedulerBusy||stripeBusy)await new Promise(r=>setTimeout(r,20));};
}
