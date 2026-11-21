import { loadEnv } from '../packages/shared/env.js';
import { randomUUID } from 'node:crypto';
import { redisCommand } from '../packages/upstash/index.js';
loadEnv();
try {
 const result=await redisCommand(['PING']);
 if(result!=='PONG')throw new Error('Unexpected result');
 const prefix=`emavanta:diagnostic:${randomUUID()}`;
 const script="redis.call('SET',KEYS[1],'ok','EX',15); redis.call('SET',KEYS[2],'ok','EX',15); local v=redis.call('GET',KEYS[1])..redis.call('GET',KEYS[2]); redis.call('DEL',KEYS[1],KEYS[2]); return v";
 if(await redisCommand(['EVAL',script,'2',`${prefix}:a`,`${prefix}:b`])!=='okok')throw new Error('Redis script check failed');
 console.log('Upstash Redis REST PING and short-lived multi-key Lua write/read/delete succeeded. This does not prove capacity or queue readiness.');
 console.log('Queue backend: MongoDB (BullMQ is not installed).');
 console.log(`Rate limit backend: ${String(process.env.RATE_LIMIT_BACKEND||'mongo').toLowerCase()}`);
} catch(e) {console.error(`Upstash check failed (${e.code==='UPSTASH_CONFIG'?'UPSTASH_CONFIG':'UPSTASH_UNAVAILABLE'}). Check URL, token, database status and network. Do not share credentials.`);process.exitCode=1;}
