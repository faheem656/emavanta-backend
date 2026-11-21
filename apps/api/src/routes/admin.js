import { config } from '../config.js';
import { collection, dbInfo, isMemoryMode, withMongoTransaction, nativeDatabase } from '../../../../packages/database/store.js';
import { validAddress } from '../payments/bsc.js';
import { stripeReadiness } from '../payments/stripe-service.js';
import { cryptoSetupDiagnostics, addMonthsClamped } from '../payments/crypto-service.js';
import { smtpConfigured } from '../mail-auth.js';
import { getQueue, queueReadiness } from '../../../../packages/queue/index.js';
import { AppError, badRequest, notFound, conflict, forbidden } from '../../../../packages/shared/errors.js';
import { platformOwnerAccess, requirePlatformOwner } from '../platform-owner.js';
import { PLANS } from '../../../../packages/entitlements/definitions.js';
import { newId } from '../../../../packages/shared/utils.js';

const assertAdmin = requirePlatformOwner;

export default async function adminRoutes(app) {
  app.get('/admin/access', async req => platformOwnerAccess(req.ctx));

  // Contact submissions are visible only to the MFA-verified platform owner.
  app.get('/admin/contact-messages',async req=>{
    await assertAdmin(req.ctx);
    const rows=await collection('contact_messages').find({}, {sort:{createdAt:-1},limit:100});
    return rows.map(({_id,name,email,company,topic,message,deliveryStatus,createdAt,sentAt})=>({id:_id,name,email,company,topic,message,deliveryStatus:deliveryStatus||'unknown',createdAt,sentAt}));
  });

  app.post('/admin/contact-messages/:id/retry',async req=>{
    await assertAdmin(req.ctx);if(isMemoryMode())throw forbidden('Persistent storage is required.');
    const db=nativeDatabase(), id=req.params.id;
    const row=await db.collection('contact_messages').findOne({_id:id,deliveryStatus:'failed'});
    if(!row)throw conflict('Only a failed notification can be retried. Refresh first.');
    const event=await db.collection('outbox_events').findOne({type:'contact.notify','payload.contactId':id});
    if(!event)throw conflict('The notification record is unavailable; review this message manually.');
    const jobId=`outbox-${event._id}`;
    const failed=await db.collection('queue_jobs').findOne({queue:'contact_mail',jobId,state:'failed'});
    if(!failed)throw conflict('The notification is still being processed. Refresh and check its status.');
    await getQueue('contact_mail').add('contact.notify',{contactId:id},{jobId,retryFailed:true});
    await db.collection('contact_messages').updateOne({_id:id,deliveryStatus:'failed'},{$set:{deliveryStatus:'queued'}});
    return {ok:true,message:'Notification queued for retry. Inbox delivery is not guaranteed.'};
  });

  // Presence and connectivity are distinct; never disclose secrets or provider URLs.
  app.get('/admin/setup-status', async req => {
    await assertAdmin(req.ctx);
    const db = dbInfo();
    const queue = await queueReadiness();
    const crypto = await cryptoSetupDiagnostics();
    const stripe = await stripeReadiness();
    return { database: { configured: db.driver === 'mongo', connected: db.driver === 'mongo' && db.connected },
      queue, smtp: { configured: smtpConfigured(), deliveryVerified: false },
      bsc: { addressConfigured: validAddress(process.env.BSC_USDT_RECEIVING_ADDRESS), rpcConfigured: !!String(process.env.BSC_RPC_URL || '').trim(), paymentsActive: crypto.available },
      stripe: {available:stripe.available},
      cryptoReview: { available: crypto.available, checks:crypto.checks, reason: crypto.available ? 'Configured; independent security and live testing remain required.' : 'Disabled or setup prerequisites not met.' } };
  });

  // Only a verified platform owner who has completed MFA in this session can
  // access cross-workspace data. Do not return password hashes or credentials.
  app.get('/admin/workspaces', async req => {
    await assertAdmin(req.ctx);
    const orgs = await collection('organizations').find({}, { sort: { createdAt: -1 }, limit: 100 });
    return Promise.all(orgs.map(async org => {
      const owner = org.ownerId ? await collection('users').findOne({ _id: org.ownerId }) : null;
      const invoices = await collection('invoices').find({ organizationId: org._id }, { sort: { createdAt: -1 }, limit: 5 });
      return { id: org._id, name: org.name, plan: org.plan || 'free', status: org.status || 'active', planSource:org.planChangeSource || null, planStartedAt:org.planStartedAt || null, planExpiresAt:org.planExpiresAt || null,
        owner: owner ? { name: owner.name, email: owner.email, emailVerified: owner.emailVerified === true } : null,
        invoices: invoices.map(i => ({ number:i.number, amount:i.amount, currency:i.currency, status:i.status, method:i.method, date:i.date })) };
    }));
  });

  app.get('/admin/users', async req => {
    await assertAdmin(req.ctx);
    const skip=Math.max(0,Math.min(10000000,Number.parseInt(req.query?.skip||'0',10)||0));
    const users = await collection('users').find({}, { sort:{ createdAt:-1, _id:-1 }, limit:50, skip });
    return users.map(u => ({ id:u._id, name:u.name, email:u.email, emailVerified:u.emailVerified === true, status:u.platformStatus||'active', createdAt:u.createdAt }));
  });

  // Soft delete retains financial and workspace records. Existing sessions and API
  // keys are revoked atomically. Restoring an account does not restore old keys.
  app.post('/admin/users/:id/status', async req => {
    await assertAdmin(req.ctx);
    if(isMemoryMode())throw new AppError(503,'PERSISTENCE_REQUIRED','Account administration requires persistent database storage.');
    const status=String(req.body?.status||''),reason=String(req.body?.reason||'').trim();
    if(!['active','suspended','deleted'].includes(status))throw badRequest('Choose a valid account status.');
    if(reason.length<10||reason.length>500)throw badRequest('Provide a reason of 10–500 characters.');
    const actorId=req.ctx.user.id,targetId=req.params.id,now=new Date().toISOString();
    return withMongoTransaction(async(db,session)=>{
      const users=db.collection('users'),target=await users.findOne({_id:targetId},{session});
      if(!target)throw notFound('Account not found.');
      if(targetId===actorId || String(target.email||'').trim().toLowerCase()===String(process.env.PLATFORM_OWNER_EMAIL||'').trim().toLowerCase())throw badRequest('The platform owner account cannot be changed here.');
      const prior=target.platformStatus||'active';
      if(prior===status)return {ok:true,status,unchanged:true};
      const changed=await users.updateOne({_id:targetId},{$set:{platformStatus:status,platformStatusChangedAt:now}},{session});
      if(!changed.matchedCount)throw conflict('Account changed. Refresh and try again.');
      {
        await db.collection('sessions').updateMany({userId:targetId,status:'active'},{$set:{status:'revoked',revokedAt:now,revokedReason:'platform_account_status'}},{session});
        await db.collection('api_keys').updateMany({createdBy:targetId,status:'active'},{$set:{status:'revoked',revokedAt:now,revokedReason:'platform_account_status'}},{session});
      }
      await db.collection('platform_admin_events').insertOne({_id:newId(),actorId,targetUserId:targetId,type:'account_status',from:prior,to:status,reason,status:'applied',createdAt:now},{session});
      return {ok:true,status};
    });
  });

  app.post('/admin/workspaces/:id/plan', async req => {
    await assertAdmin(req.ctx);
    if (config.storage !== 'mongo') throw new AppError(503, 'PERSISTENCE_REQUIRED', 'Plan changes require persistent database storage.');
    const plan = String(req.body?.plan || '');
    const reason = String(req.body?.reason || '').trim();
    const expectedPlan = String(req.body?.expectedPlan || '');
    if (!Object.hasOwn(PLANS, plan)) throw badRequest('Choose a valid plan.');
    if (reason.length < 10 || reason.length > 500) throw badRequest('Explain the reason in 10–500 characters.');
    const org = await collection('organizations').findOne({ _id: req.params.id });
    if (!org) throw notFound('Workspace not found.');
    if ((org.plan || 'free') !== expectedPlan) throw conflict('The plan changed. Refresh and try again.');
    const expectedSource = req.body?.expectedSource ?? null, expectedExpiry = req.body?.expectedExpiry ?? null, expectedStart = req.body?.expectedStart ?? null;
    if ((org.planChangeSource || null) !== expectedSource || (org.planExpiresAt || null) !== expectedExpiry || (org.planStartedAt || null) !== expectedStart) throw conflict('Plan details changed. Refresh and try again.');
    const now = new Date();
    const interval = plan === 'free' ? null : req.body?.interval;
    if (plan !== 'free' && !['month','year'].includes(interval)) throw badRequest('Choose a monthly or yearly term.');
    const start = plan === 'free' ? now : new Date(req.body?.startedAt || '');
    if (!Number.isFinite(start.getTime()) || start.getTime() > now.getTime() + 60000) throw badRequest('Choose a valid start time that is not in the future.');
    const end = interval ? addMonthsClamped(start, interval === 'year' ? 12 : 1) : null;
    if (end && end <= now) throw badRequest('This term has already ended. Choose an active start date.');
    const startedAt=start.toISOString(), expiresAt=end?.toISOString() || null;
    // Plan and audit are one transaction; this is not a payment or auto-renewal.
    return withMongoTransaction(async (db, session) => {
      const orgs=db.collection('organizations');
      const change=await orgs.updateOne({_id:org._id,plan:expectedPlan,planChangeSource:expectedSource,planExpiresAt:expectedExpiry,planStartedAt:expectedStart},
        {$set:{plan,planChangedAt:now.toISOString(),planStartedAt:startedAt,planExpiresAt:expiresAt,planInterval:interval,planChangeSource: plan==='free'?'free':'platform_manual_override'}},{session});
      if(!change.matchedCount)throw conflict('Plan details changed. Refresh and try again.');
      await db.collection('platform_admin_events').insertOne({_id:newId(),actorId:req.ctx.user.id,targetOrganizationId:org._id,type:'manual_plan_override',from:expectedPlan,to:plan,reason,status:'applied',startedAt,expiresAt,interval,createdAt:now.toISOString()},{session});
      return {ok:true,plan,startedAt,expiresAt,interval,message:'Manual plan term saved. No payment was recorded and no automatic renewal was scheduled.'};
    });
  });

  app.get('/admin/overview', async req => {
    await assertAdmin(req.ctx);
    const queues = {};
    for (const name of ['outbox','campaign','outreach','webhook','analytics','import','billing']) {
      queues[name] = await getQueue(name).getJobCounts();
    }
    return { queues, users: await collection('users').countDocuments(), organizations: await collection('organizations').countDocuments(),
      queuedJobs: Object.values(queues).reduce((s, q) => s + q.waiting, 0) };
  });
  /** Everything a production launch needs, with a pass/warn/fail per item. */
  app.get('/admin/readiness', async req => {
    await assertAdmin(req.ctx);
    const { API_SCHEMA } = await import('./health.js');
    const env = process.env;
    const { dbInfo } = await import('../../../../packages/database/store.js');
    const storage = dbInfo();
    const queue = await queueReadiness();
    const items = [
      { key:'demo_mode', label:'Demo mode disabled', ok: env.DEMO_MODE !== 'true',
        detail: env.DEMO_MODE === 'true' ? 'Set DEMO_MODE=false for deployment' : 'real auth enforced',
        fix:'Set DEMO_MODE=false (or remove it) before production.' },
      { key:'jwt', label:'JWT secret replaced', ok: !!env.JWT_SECRET && !/demo-jwt-secret/.test(env.JWT_SECRET || ''),
        detail: env.JWT_SECRET ? (env.JWT_SECRET.length >= 32 ? 'strong secret present' : 'secret too short') : 'using the built-in demo secret',
        fix:'JWT_SECRET=$(openssl rand -hex 32)' },
      { key:'mongo', label:'Persistent database', ok: storage.driver === 'mongo' && storage.connected,
        detail: storage.driver === 'mongo'
          ? (storage.connected ? `MongoDB connected · db=${storage.database} · host=${storage.host}` : `MongoDB configured but NOT reachable: ${storage.error || 'connection failed'}`)
          : 'in-memory store (data resets on restart)',
        fix: storage.driver === 'mongo'
          ? 'Check Atlas → Network Access (your IP) and the password encoding, then run `npm run db:check`.'
          : 'MONGODB_URI=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/emavanta?retryWrites=true&w=majority — verify with `npm run db:check`' },
      { key:'queue', label:'Persistent jobs', ok: queue.ready, detail: queue.ready ? 'MongoDB-backed queue' : 'in-memory queue; jobs are not durable',
        fix:'Configure persistent MONGODB_URI and restart.' },
      { key:'billing', label:'Payment settlement', ok: false, detail: 'Card and crypto payments are disabled pending secure integration and verification.', fix:'Complete and independently review payment integration before launch.' },
      { key:'tracking', label:'Public tracking base URL', ok: !!env.APP_URL && !/localhost/.test(env.APP_URL || ''),
        detail: env.APP_URL || 'defaults to http://localhost:3000', fix:'APP_URL=https://yourdomain.com' },
      { key:'encryption', label:'Credential encryption key', ok: !!env.ENCRYPTION_KEY, detail: env.ENCRYPTION_KEY ? 'key present' : 'derived from JWT secret',
        fix:'ENCRYPTION_KEY=$(openssl rand -hex 32)' }
    ];
    const score = Math.round((items.filter(i => i.ok).length / items.length) * 100);
    return { schema: API_SCHEMA, score, ready: items.every(i => i.ok), items, storage,
      demo: env.DEMO_MODE === 'true', node: process.version, platform: process.platform,
      checks: ['npm test', 'npm run build', 'npm run smoke'].map(c => ({ command: c })) };
  });

  app.get('/admin/health', async req => {
    await assertAdmin(req.ctx);
    return { api: 'ok', mode: configMode(), timestamp: new Date().toISOString() };
  });
}
const configMode = () => process.env.DEMO_MODE === 'true' ? 'demo' : 'full';
