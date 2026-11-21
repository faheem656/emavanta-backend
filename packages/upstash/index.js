// Minimal Upstash Redis REST client. Never log tokens, URLs, or response bodies.
// Mutating requests are not retried: a timeout may mean Redis applied the command.
export async function redisCommand(command) {
  const raw=String(process.env.UPSTASH_REDIS_REST_URL||'').trim();
  const token=String(process.env.UPSTASH_REDIS_REST_TOKEN||'').trim();
  let url;
  try { url=new URL(raw); } catch { throw Object.assign(new Error('Upstash REST URL is not configured correctly'),{code:'UPSTASH_CONFIG'}); }
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!token) throw Object.assign(new Error('Upstash HTTPS URL and token are required'),{code:'UPSTASH_CONFIG'});
  try {
    const response=await fetch(url.toString(),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(command),redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('HTTP error');
    const result=await response.json();
    if(result?.error || !Object.prototype.hasOwnProperty.call(result||{},'result'))throw new Error('Redis command failed');
    return result.result;
  } catch {throw Object.assign(new Error('Upstash request failed; check configuration and connectivity'),{code:'UPSTASH_UNAVAILABLE'});}
}
