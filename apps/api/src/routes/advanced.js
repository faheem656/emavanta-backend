import { scoped, collection, isMemoryMode } from '../../../../packages/database/store.js';
import { assertPermission, PERMISSIONS } from '../../../../packages/security/rbac.js';
import { getQueue } from '../../../../packages/queue/index.js';
import { newId, stableHash } from '../../../../packages/shared/utils.js';
import { writeWithOutbox } from '../../../../packages/database/outbox.js';
import { acquire } from '../../../../packages/rate-limiter/index.js';
import { hashToken } from '../../../../packages/security/encryption.js';
import { tooMany, badRequest, AppError } from '../../../../packages/shared/errors.js';

const orgPlan = async ctx => ctx.demo ? 'growth' : (await collection('organizations').findOne({ _id: ctx.organizationId }))?.plan || 'free';

export default async function advancedRoutes(app) {
  // Store the submission and notification event atomically. Never claim SMTP delivery
  // merely because the message was saved; a worker handles owner notification.
  app.post('/contact', {bodyLimit:8192}, async req => {
    const body=req.body||{}, text=v=>typeof v==='string'?v.trim():'';
    const name=text(body.name), email=text(body.email).toLowerCase(), company=text(body.company), topic=text(body.topic)||'Other', message=text(body.message);
    const fields=[];
    if(name.length<2||name.length>80||/[\r\n]/.test(name))fields.push({field:'name',message:'Enter a name between 2 and 80 characters.'});
    if(email.length>160||!/^[^@\s,;<>:"\[\]]+@[^@\s,;<>:"\[\]]+\.[^@\s,;<>:"\[\]]{2,}$/.test(email))fields.push({field:'email',message:'Enter a valid email address.'});
    if(company.length>100||/[\r\n]/.test(company))fields.push({field:'company',message:'Company must be 100 characters or fewer.'});
    if(!['Sales','Support','Partnership','Security','Other'].includes(topic))fields.push({field:'topic',message:'Select a valid topic.'});
    if(message.length<12||message.length>2000)fields.push({field:'message',message:'Enter a message between 12 and 2,000 characters.'});
    if(fields.length)throw badRequest(fields[0].message,{fields});
    if(isMemoryMode() && process.env.NODE_ENV!=='test')throw new AppError(503,'CONTACT_UNAVAILABLE','Contact service is temporarily unavailable. Please try again later.');
    const owner=String(process.env.PLATFORM_OWNER_EMAIL||'').trim();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(owner))throw new AppError(503,'CONTACT_UNAVAILABLE','Contact service is temporarily unavailable. Please try again later.');
    // Do not trust forwarding headers unless the API is configured with specific trusted proxies.
    // Hash the address so it is not stored in contact records or rate-bucket keys.
    const ipHash=stableHash('contact-ip',String(req.ip||'unknown'));
    const bucket={keys:[{organizationId:'public-contact',stream:'contact',accountId:ipHash,capacity:8,refillPerSec:8/3600}]};
    let limit;
    try { limit=await acquire(bucket); }
    catch (error) {
      // Contact messages may use the shared MongoDB limiter when Redis is down.
      // This is bounded, not a bypass; sending paths continue to fail closed.
      if (!['UPSTASH_UNAVAILABLE','UPSTASH_CONFIG'].includes(error?.code) || isMemoryMode()) throw error;
      console.warn('[contact] Upstash unavailable; using the shared MongoDB contact limiter.');
      limit=await acquire({...bucket,driver:'mongo'});
    }
    if(!limit.ok)throw tooMany('Too many messages. Please try again later.');
    const id=newId(), now=new Date().toISOString();
    const result=await writeWithOutbox({organizationId:'platform-contact',docs:[{name:'contact_messages',doc:{_id:id,name,email,company,topic,message,deliveryStatus:'queued',createdAt:now}}],
      event:{type:'contact.notify',queue:'contact_mail',payload:{contactId:id}}});
    // Optimization only: the scheduled outbox sweep also recovers unpublished events.
    void getQueue('outbox').add('outbox.publish',{eventId:result.event._id},{jobId:`outbox-${result.event._id}`,retryFailed:true}).catch(()=>{});
    return {ok:true,email,reference:id.slice(0,8),topic,delivery:'queued'};
  });

  // API keys: can never exceed the creator's permissions
  app.get('/api-keys', async req => scoped('api_keys', req.ctx).find({}));
  app.post('/api-keys', async req => {
    assertPermission(req.ctx, PERMISSIONS.ORG_SETTINGS);
    const raw = `orv_${newId().replace(/-/g,'')}`;
    const key = await scoped('api_keys', req.ctx).create({ _id: newId(), name: req.body.name, tokenHash: hashToken(raw),
      scopes: req.body.scopes || ['campaigns:read'], createdBy: req.ctx.user.id,
      expiresAt: new Date(Date.now() + (req.body.expiresInDays || 90) * 864e5).toISOString(),
      ipAllowlist: req.body.ipAllowlist || [], status: 'active' });
    return { id: key._id, token: raw, note: 'Store now — shown once' };
  });
  app.delete('/api-keys/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.ORG_SETTINGS);
    await scoped('api_keys', req.ctx).deleteOne({ _id: req.params.id });
    return { ok: true };
  });

  // CRM
  app.get('/crm/deals', async req => scoped('deals', req.ctx).find({}));
  app.post('/crm/deals', async req => scoped('deals', req.ctx).create({ _id: newId(), stage: 'new', value: 0, ...req.body }));
  app.patch('/crm/deals/:id', async req => { await scoped('deals', req.ctx).updateOne({ _id: req.params.id }, { $set: req.body }); return { ok:true }; });
  app.get('/crm/tasks', async req => scoped('tasks', req.ctx).find({}));
  app.post('/crm/tasks', async req => scoped('tasks', req.ctx).create({ _id: newId(), status: 'open', ...req.body }));
  app.patch('/crm/tasks/:id', async req => { await scoped('tasks', req.ctx).updateOne({ _id: req.params.id }, { $set: req.body }); return { ok:true }; });

  // Landing pages. Forms have their own module (routes/forms.js).
  app.get('/landing-pages', async req => scoped('landing_pages', req.ctx).find({}));
  app.post('/landing-pages', async req => scoped('landing_pages', req.ctx).create({ _id: newId(), status: 'draft', ...req.body }));

  // Calendar / meetings
  app.get('/calendar/events', async req => scoped('calendar_events', req.ctx).find({}));
  app.post('/calendar/events', async req => scoped('calendar_events', req.ctx).create({ _id: newId(), ...req.body }));
  app.get('/calendar/meeting-links', async req => scoped('meeting_links', req.ctx).find({}));
  app.post('/calendar/meeting-links', async req => scoped('meeting_links', req.ctx).create({ _id: newId(), slug: stableHash('meet', req.ctx.organizationId, String(req.body.name)), ...req.body }));

  // Outbound webhooks
  app.get('/webhooks-out', async req => scoped('webhooks_out', req.ctx).find({}));
  app.post('/webhooks-out', async req => {
    assertPermission(req.ctx, PERMISSIONS.ORG_SETTINGS);
    return scoped('webhooks_out', req.ctx).create({ _id: newId(), url: req.body.url, events: req.body.events || ['delivered'],
      status: 'active', secret: newId() });
  });

  // Audit log (owner/admin)
  app.get('/audit-logs', async req => {
    assertPermission(req.ctx, PERMISSIONS.AUDIT_READ);
    return collection('audit_logs').find({ organizationId: req.ctx.organizationId }, { sort: { createdAt: -1 }, limit: Number(req.query.limit||100) });
  });

  // Suppression management
  app.get('/suppressions', async req => scoped('suppressions', req.ctx).find({}, { limit: Number(req.query.limit||100) }));
  app.post('/suppressions', async req => scoped('suppressions', req.ctx).create({ _id: newId(), email: req.body.email, reason: 'manual', createdAt: new Date().toISOString() }));

  // Usage alerts + projected completion
  app.get('/billing/alerts', async req => {
    const plan = await orgPlan(req.ctx);
    const used = await scoped('messages', req.ctx).countDocuments({});
    const limit = (await import('../../../../packages/entitlements/definitions.js')).limitFor(plan, 'sends', req.ctx.addons || {});
    const pct = limit > 0 ? Math.round(used / limit * 100) : 0;
    const level = pct >= 100 ? 'blocked' : pct >= 90 ? 'critical' : pct >= 80 ? 'warning' : 'ok';
    return { used, limit, pct, level, message: level === 'ok' ? null : `${pct}% of send capacity used` };
  });

  // Schedule a report job
  app.post('/reports', async req => {
    const report = await scoped('reports', req.ctx).create({ _id: newId(), type: req.body.type || 'campaign', status: 'queued' });
    await getQueue('report').add('report.generate', { organizationId: req.ctx.organizationId, reportId: report._id },
      { jobId: stableHash('report', report._id) });
    return report;
  });
}
