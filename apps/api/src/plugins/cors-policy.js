/** Browser CORS is not authentication. The API still verifies every protected request. */
export function allowedFrontendOrigins(env = process.env) {
  if (env.NODE_ENV === 'production' && !String(env.APP_URL || '').trim()) throw new Error('APP_URL must be set to the public frontend origin in backend environment');
  const raw = [env.APP_URL, ...String(env.CORS_ALLOWED_ORIGINS || '').split(',')].filter(Boolean);
  if (!raw.length && env.NODE_ENV !== 'production') raw.push('http://localhost:3000', 'http://127.0.0.1:3000');
  return new Set(raw.map(value => {
    let u;
    try { u = new URL(String(value).trim()); } catch { throw new Error('APP_URL and CORS_ALLOWED_ORIGINS must be valid http(s) origins'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
      throw new Error('APP_URL and CORS_ALLOWED_ORIGINS must contain origins only, without paths or credentials');
    return u.origin;
  }));
}

export function corsDelegator(allowed) {
  return (req, callback) => {
    const path = String(req.raw.url || '').split('?')[0];
    // Public embedded forms must be accessible from a customer's website. They do
    // not need cookies or authorization and remain subject to server-side validation.
    if (/^\/api\/v1\/public\/forms\/[^/]+(?:\/submit)?\/?$/.test(path)) {
      return callback(null, { origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['content-type'], credentials: false });
    }
    const origin = req.headers.origin;
    return callback(null, { origin: origin && allowed.has(origin) ? origin : false,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['content-type', 'authorization', 'x-api-key'], credentials: false });
  };
}
