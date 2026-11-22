import { randomUUID } from 'node:crypto';
import { redisCommand } from './index.js';

// Explicit operator diagnostic; keys expire even if interrupted. Does not print secrets.
export async function checkUpstash() {
  let ping=false;
  try {
    if (await redisCommand(['PING']) !== 'PONG') throw new Error('Unexpected PING');
    ping=true;
    const key=`emavanta:diagnostic:${randomUUID()}`;
    const script="redis.call('SET',KEYS[1],'ok','EX',15); redis.call('SET',KEYS[2],'ok','EX',15); local v=redis.call('GET',KEYS[1])..redis.call('GET',KEYS[2]); redis.call('DEL',KEYS[1],KEYS[2]); return v";
    if (await redisCommand(['EVAL',script,'2',`${key}:a`,`${key}:b`]) !== 'okok') throw new Error('Unexpected script result');
    return {ok:true, ping:true, multiKeyLua:true};
  } catch(e) {
    return {ok:false, code:e?.code==='UPSTASH_CONFIG'?'UPSTASH_CONFIG':'UPSTASH_UNAVAILABLE', ping, multiKeyLua:false};
  }
}
