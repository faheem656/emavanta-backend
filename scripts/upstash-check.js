import { loadEnv } from '../packages/shared/env.js';
import { checkUpstash } from '../packages/upstash/diagnostics.js';
loadEnv();
const result=await checkUpstash();
if(result.ok){
 console.log('Upstash Redis REST PING and short-lived multi-key Lua write/read/delete succeeded. This does not prove capacity or queue readiness.');
 console.log('Queue backend: MongoDB (BullMQ is not installed).');
 console.log(`Rate limit backend: ${String(process.env.RATE_LIMIT_BACKEND||'mongo').toLowerCase()}`);
} else {console.error(`Upstash check failed (${result.code}). Check URL, token, database status, multi-key Lua support and network. Do not share credentials.`);process.exitCode=1;}
