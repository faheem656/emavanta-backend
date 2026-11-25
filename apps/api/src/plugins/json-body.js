// Preserve exact JSON bytes for Stripe's signature verification while parsing
// ordinary requests normally. Empty JSON requests remain supported.
export function installJsonParser(app) {
 app.decorateRequest('rawBody', null);
 app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 6 * 1024 * 1024 }, (req, body, done) => {
  if(req.url.split('?')[0]==='/api/v1/webhooks/stripe')req.rawBody=body;
  if(body===undefined||body===null||String(body).trim()==='')return done(null,{});
  try{done(null,JSON.parse(body));}catch(err){err.statusCode=400;done(err);}
 });
}
