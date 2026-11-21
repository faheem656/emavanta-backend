// Shared MongoDB token buckets, using compare-and-swap so multiple processes
// cannot multiply a tenant's sending allowance. Memory mode is local-only.
import { upstashBuckets } from '../upstash/rate.js';
import { stableHash } from '../shared/utils.js';
import { nativeDatabase, isMemoryMode } from '../database/store.js';
const memory=new Map();
export const limitKey=({organizationId,stream='marketing',accountId='shared',domain='shared',lane='standard'})=>
  `rl:${organizationId}:${stream}:${accountId}:${domain}:${lane}`;
const dbBuckets=()=>nativeDatabase().collection('rate_buckets');
async function mutate(spec, quantity, refunding=false) {
  const {key,capacity,refillPerSec}=spec;
  const id=stableHash('rate',key);
  for(let tries=0;tries<50;tries++){
    const now=Date.now();
    let state=isMemoryMode()?memory.get(key):await dbBuckets().findOne({_id:id});
    if(!state){
      state={_id:id,key,tokens:capacity,last:now,version:0};
      if(isMemoryMode())memory.set(key,state);
      else {try{await dbBuckets().insertOne(state);}catch(e){if(e.code===11000)continue;throw e;}}
    }
    const elapsed=Math.max(0,now-state.last)/1000;
    let tokens=Math.min(capacity,state.tokens+elapsed*refillPerSec);
    const allowed=refunding||tokens>=quantity;
    if(refunding)tokens=Math.min(capacity,tokens+quantity);else if(allowed)tokens-=quantity;
    const retryAfter=allowed?0:Math.ceil((quantity-tokens)/Math.max(refillPerSec,0.01));
    const next={tokens,last:Math.max(now,state.last),version:state.version+1};
    if(isMemoryMode()){memory.set(key,{...state,...next});return {ok:allowed,remaining:Math.floor(tokens),retryAfter,key};}
    const result=await dbBuckets().updateOne({_id:id,version:state.version},{$set:next});
    if(result.matchedCount)return {ok:allowed,remaining:Math.floor(tokens),retryAfter,key};
  }
  throw new Error('Rate limiter is busy; retry later');
}
export const acquire=async({keys=[],quantity=1,lane='standard'})=>{
  if(!Number.isFinite(quantity)||quantity<=0)throw new Error('Invalid rate-limit quantity');
  const driver=String(process.env.RATE_LIMIT_BACKEND||'mongo').trim().toLowerCase();
  if(!['mongo','upstash'].includes(driver))throw new Error('Invalid rate-limit backend');
  if(driver==='upstash'){
    const specs=keys.map(spec=>{
      const capacity=Number(spec.capacity||60),refillPerSec=Number(spec.refillPerSec??1);
      if(!Number.isFinite(capacity)||capacity<=0||!Number.isFinite(refillPerSec)||refillPerSec<0)throw new Error('Invalid rate-limit configuration');
      return {key:limitKey({...spec,lane:spec.lane||lane}),capacity,refillPerSec,quantity};
    });
    const result=await upstashBuckets(specs);
    return result.ok?{ok:true,acquired:specs,remaining:result.remaining}:result;
  }
  const acquired=[];
  for(const spec of keys){
    const key=limitKey({...spec,lane:spec.lane||lane});
    const capacity=Number(spec.capacity||60),refillPerSec=Number(spec.refillPerSec??1);
    if(!Number.isFinite(capacity)||capacity<=0||!Number.isFinite(refillPerSec)||refillPerSec<0)throw new Error('Invalid rate-limit configuration');
    const current={key,capacity,refillPerSec,quantity};
    let result;
    try {result=await mutate(current,quantity);} catch(error){for(const undo of acquired.reverse())await mutate(undo,undo.quantity,true);throw error;}
    if(!result.ok){for(const undo of acquired.reverse())await mutate(undo,undo.quantity,true);return {ok:false,retryAfter:result.retryAfter,blockedKey:key};}
    acquired.push(current);
  }
  return {ok:true,acquired,remaining:acquired[0]&&isMemoryMode()?memory.get(acquired[0].key)?.tokens:null};
};
export const refund=async acquired=>{if(String(process.env.RATE_LIMIT_BACKEND||'mongo').trim().toLowerCase()==='upstash'){await upstashBuckets(acquired||[],true);return;} for(const spec of [...(acquired||[])].reverse())await mutate(spec,spec.quantity||1,true);};
export const acquireStream=async({organizationId,stream,accountId,domain,streamCapacity=60,streamRefill=1,
  accountCapacity=30,accountRefill=0.5,domainCapacity=120,domainRefill=2,quantity=1})=>{
  const lane=stream==='transactional'?'critical':stream==='outreach'?'outreach':'bulk';
  return acquire({lane,quantity,keys:[
    {organizationId,stream,accountId:'shared',domain:'shared',lane,capacity:streamCapacity,refillPerSec:streamRefill},
    {organizationId,stream,accountId,domain:'shared',lane,capacity:accountCapacity,refillPerSec:accountRefill},
    {organizationId,stream,accountId:'shared',domain,lane,capacity:domainCapacity,refillPerSec:domainRefill}
  ]});
};
export const resetRateLimiter=()=>memory.clear();
