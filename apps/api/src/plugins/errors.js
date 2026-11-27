import fp from 'fastify-plugin';
import { AppError } from '../../../../packages/shared/errors.js';
import { isMongoUnavailable, noteMongoFailure } from '../../../../packages/database/store.js';
import { redact } from '../../../../packages/shared/utils.js';

/** Zod failures are the caller's mistake, not a server crash: report them as 422. */
const zodIssues = err => {
  if (!err || err.name !== 'ZodError' || !Array.isArray(err.issues)) return null;
  return err.issues.map(i => ({ path: (i.path || []).join('.'), message: i.message, code: i.code }));
};

let lastMongoLog=0;
export const errorPlugin = fp(async app => {
  // A handler that accidentally returns nothing used to produce "200 OK" with a
  // zero-byte body — the dashboard then rendered empty lists. Never emit an
  // empty 2xx: serialize it as {} so clients always receive parseable JSON.
  app.addHook('onSend', (req, reply, payload, done) => {
    if ((payload === undefined || payload === '') && reply.statusCode >= 200 && reply.statusCode < 300) {
      reply.header('content-type', 'application/json; charset=utf-8');
      return done(null, '{}');
    }
    done(null, payload);
  });
  app.setErrorHandler((err, req, reply) => {
    if (isMongoUnavailable(err)) {
      noteMongoFailure(err);const now=Date.now();if(now-lastMongoLog>30000){lastMongoLog=now;console.error('[db] Request failed: database unavailable. Driver will retry connections; check database/network access.');}
      return reply.code(503).send({error:{code:'DATABASE_UNAVAILABLE',message:'Database connection is temporarily unavailable. If you submitted an action, check its status before trying again.',requestId:req.id}});
    }
    if (['UPSTASH_UNAVAILABLE','UPSTASH_CONFIG'].includes(err.code)) {
      return reply.code(503).send({error:{code:'RATE_LIMIT_SERVICE_UNAVAILABLE',message:'The service is temporarily busy. Please try again later.',requestId:req.id}});
    }
    const issues = zodIssues(err);
    // Fastify's own schema/body errors carry statusCode 400 and a message like
    // "body/blocks must be array" — keep that text instead of a generic error.
    const status = issues ? 422 : (err instanceof AppError ? err.statusCode : (err.statusCode || 500));
    const body = { error: {
      code: issues ? 'VALIDATION_ERROR' : (err.code || 'INTERNAL'),
      message: issues
        ? `Some fields need attention: ${issues.slice(0, 3).map(i => `${i.path || 'body'} — ${i.message}`).join('; ')}`
        : status >= 500 && err.code!=='CONTACT_UNAVAILABLE' ? 'Internal error' : err.message,
      details: issues ? { fields: issues } : (status < 500 ? err.details : undefined),
      requestId: req.id
    } };
    if (status >= 500) console.error('[error]', redact({ err: err.message, stack: err.stack, url: req.url }));
    reply.code(status).send(body);
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
});
