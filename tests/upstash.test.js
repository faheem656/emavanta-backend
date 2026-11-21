import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { upstashBuckets } from '../packages/upstash/rate.js';
import { redisCommand } from '../packages/upstash/index.js';
import { acquire, refund } from '../packages/rate-limiter/index.js';
const exec=promisify(execFile);
let redisPresent=true;try{execFileSync('redis-server',['--version'],{stdio:'ignore'});}catch{redisPresent=false;}

test('Upstash limiter executes real Lua atomically through REST-shaped transport', {skip:!redisPresent}, async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const proc=spawn('redis-server',['--port',String(port),'--bind','127.0.0.1','--save','','--appendonly','no'],{stdio:'ignore'});
 const original=globalThis.fetch, oldUrl=process.env.UPSTASH_REDIS_REST_URL,oldToken=process.env.UPSTASH_REDIS_REST_TOKEN,oldDriver=process.env.RATE_LIMIT_BACKEND;
 try {
  let ready=false;for(let i=0;i<50&&!ready;i++){try{await exec('redis-cli',['-p',String(port),'PING']);ready=true;}catch{await new Promise(r=>setTimeout(r,40));}}
  assert.ok(ready);
  process.env.UPSTASH_REDIS_REST_URL='https://example.upstash.io';process.env.UPSTASH_REDIS_REST_TOKEN='fake-secret';
  globalThis.fetch=async(url,opts)=>{
   assert.equal(opts.headers.Authorization,'Bearer fake-secret');assert.equal(opts.redirect,'error');
   const args=JSON.parse(opts.body);const {stdout}=await exec('redis-cli',['-p',String(port),'--json',...args]);
   return new Response(JSON.stringify({result:JSON.parse(stdout)}),{status:200});
  };
  assert.equal(await redisCommand(['PING']),'PONG');
  const spec=(key,capacity=1)=>({key,capacity,refillPerSec:0,quantity:1});
  const first=await Promise.all(Array.from({length:8},()=>upstashBuckets([spec('parallel')])));
  assert.equal(first.filter(x=>x.ok).length,1);
  assert.equal((await upstashBuckets([spec('other'),spec('parallel')])).ok,false);
  assert.equal((await upstashBuckets([spec('other')])).ok,true,'blocked multi-key request must not consume first bucket');
  await upstashBuckets([spec('parallel')],true);assert.equal((await upstashBuckets([spec('parallel')])).ok,true);
  await assert.rejects(()=>upstashBuckets([spec('dupe'),spec('dupe')]),/Duplicate/);
  process.env.RATE_LIMIT_BACKEND='upstash';
  const request={keys:[{organizationId:'org',capacity:1,refillPerSec:0}]};
  const taken=await acquire(request);assert.equal(taken.ok,true);assert.equal((await acquire(request)).ok,false);
  await refund(taken.acquired);assert.equal((await acquire(request)).ok,true);
  globalThis.fetch=async()=>{throw new Error('secret fake-secret');};
  await assert.rejects(()=>redisCommand(['PING']),e=>e.code==='UPSTASH_UNAVAILABLE'&&!e.message.includes('secret'));
 } finally {globalThis.fetch=original;if(oldDriver===undefined)delete process.env.RATE_LIMIT_BACKEND;else process.env.RATE_LIMIT_BACKEND=oldDriver;if(oldUrl===undefined)delete process.env.UPSTASH_REDIS_REST_URL;else process.env.UPSTASH_REDIS_REST_URL=oldUrl;if(oldToken===undefined)delete process.env.UPSTASH_REDIS_REST_TOKEN;else process.env.UPSTASH_REDIS_REST_TOKEN=oldToken;proc.kill('SIGTERM');}
});
