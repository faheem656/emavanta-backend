import { scoped } from '../../../../packages/database/store.js';

const TRACKED = ['queued','sent','delivered','opened','clicked','replied','bounced','complained','unsubscribed','test_sent','test_delivered'];

export default async function analyticsRoutes(app) {
  app.get('/analytics/overview', async req => {
    const campaigns = await scoped('campaigns', req.ctx).find({});
    const events = await scoped('delivery_events', req.ctx).find({});
    const byType = events.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
    const contacts = await scoped('contacts', req.ctx).countDocuments({ deleted: { $ne: true } });
    const lists = await scoped('contact_lists', req.ctx).countDocuments({});
    const automations = await scoped('sequences', req.ctx).find({});
    return { campaigns: campaigns.length, contacts, lists,
      automations: automations.length, automationsActive: automations.filter(a => a.status === 'active').length,
      stats: campaigns.reduce((acc, c) => {
      for (const k of ['sent','delivered','bounced','queued','replied','opened','clicked']) acc[k] = (acc[k] || 0) + (c.stats?.[k] || 0);
      return acc;
    }, {}), events: byType, note: 'opens are directional only (Apple Mail Privacy Protection)' };
  });

  app.get('/analytics/by-account', async req => {
    const messages = await scoped('messages', req.ctx).find({});
    const out = {};
    for (const m of messages) {
      out[m.sendingAccountId] ||= { sent: 0, test: 0 };
      if (m.status === 'test_sent') out[m.sendingAccountId].test++;
      else out[m.sendingAccountId].sent++;
    }
    return out;
  });

  /** Full delivery funnel + filtered event stream for the tracking workspace. */
  app.get('/analytics/tracking', async req => {
    const filter = {};
    if (req.query.campaignId) filter.campaignId = String(req.query.campaignId);
    if (req.query.type) filter.type = String(req.query.type);
    const events = await scoped('delivery_events', req.ctx).find(filter,
      { sort: { createdAt: -1 }, limit: Math.min(500, Number(req.query.limit || 250)) });
    const all = await scoped('delivery_events', req.ctx).find({});
    const summary = Object.fromEntries(TRACKED.map(t => [t, all.filter(e => e.type === t).length]));
    const timeline = {};
    for (const e of all) {
      const day = String(e.createdAt || '').slice(0, 10) || 'unknown';
      timeline[day] ||= Object.fromEntries(TRACKED.map(t => [t, 0]));
      if (timeline[day][e.type] !== undefined) timeline[day][e.type]++;
    }
    const campaigns = (await scoped('campaigns', req.ctx).find({})).map(c => ({
      id: c._id, name: c.name, status: c.status, stream: c.stream, stats: c.stats || {}
    }));
    return { summary, timeline, events, campaigns, total: all.length };
  });
}
