import { stableHash } from '../shared/utils.js';
import { redisCommand } from './index.js';

// One EVAL tests all buckets and commits the deductions atomically. Redis TIME
// avoids inconsistent clocks across API/worker hosts. The hash fields are never
// allowed to expire unless the bucket will already have fully refilled.
const script=`
local mode=ARGV[1]
local tm=redis.call('TIME')
local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
local data={}
for i,key in ipairs(KEYS) do
 local n=2+(i-1)*3
 local cap=tonumber(ARGV[n]); local refill=tonumber(ARGV[n+1]); local qty=tonumber(ARGV[n+2])
 local state=redis.call('HMGET',key,'tokens','last')
 local tokens=tonumber(state[1]) or cap; local last=tonumber(state[2]) or now
 tokens=math.min(cap,tokens+math.max(0,now-last)*refill/1000)
 if mode=='take' and tokens<qty then
  local retry=math.ceil((qty-tokens)/math.max(refill,0.01))
  return {0,i,retry,math.floor(tokens)}
 end
 if mode=='take' then tokens=tokens-qty else tokens=math.min(cap,tokens+qty) end
 data[i]={tokens,cap,refill}
end
for i,key in ipairs(KEYS) do
 local d=data[i]
 redis.call('HSET',key,'tokens',tostring(d[1]),'last',tostring(now))
 if d[3]>0 then redis.call('EXPIRE',key,math.max(60,math.ceil(d[2]/d[3])*2)) else redis.call('PERSIST',key) end
end
return {1,0,0,#data>0 and math.floor(data[1][1]) or 0}
`;
const keyFor=key=>`emavanta:rate:v1:${stableHash('rate',key)}`;
export async function upstashBuckets(specs,refund=false) {
 if(!specs.length)return {ok:true,remaining:null};
 const keys=specs.map(s=>keyFor(s.key));
 if(new Set(keys).size!==keys.length)throw new Error('Duplicate rate-limit bucket');
 const args=specs.flatMap(s=>[String(s.capacity),String(s.refillPerSec),String(s.quantity)]);
 const result=await redisCommand(['EVAL',script,String(keys.length),...keys,refund?'refund':'take',...args]);
 if(!Array.isArray(result)||result.length!==4)throw Object.assign(new Error('Invalid Upstash response'),{code:'UPSTASH_UNAVAILABLE'});
 const [ok,index,retryAfter,remaining]=result.map(Number);
 if(![0,1].includes(ok)||!Number.isFinite(index)||!Number.isFinite(retryAfter)||!Number.isFinite(remaining))throw Object.assign(new Error('Invalid Upstash response'),{code:'UPSTASH_UNAVAILABLE'});
 if(!ok){const spec=specs[index-1];if(!spec)throw Object.assign(new Error('Invalid Upstash response'),{code:'UPSTASH_UNAVAILABLE'});return {ok:false,blockedKey:spec.key,retryAfter};}
 return {ok:true,remaining};
}
