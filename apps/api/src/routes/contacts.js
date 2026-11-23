import { scoped } from '../../../../packages/database/store.js';
import { assertPermission, PERMISSIONS } from '../../../../packages/security/rbac.js';
import { contactSchema } from '../../../../packages/validation/index.js';
import { newId, stableHash } from '../../../../packages/shared/utils.js';
import { badRequest, notFound } from '../../../../packages/shared/errors.js';
import { getQueue } from '../../../../packages/queue/index.js';
import { createContacts } from '../../../../packages/entitlements/contacts.js';
import { recordAutomationTriggers } from '../../../../packages/automations/triggers.js';

const listName = value => {
  const name = String(value || '').trim();
  if (name.length < 2 || name.length > 80) throw badRequest('List name must be 2–80 characters');
  return name;
};

export default async function contactRoutes(app) {
  const validLists = async (ctx, ids) => {
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(x => typeof x !== 'string')) throw badRequest('Choose valid lists.');
    const unique = [...new Set(ids)];
    for (const id of unique) if (!await scoped('contact_lists', ctx).findOne({_id:id})) throw badRequest('Choose lists from this workspace.');
    return unique;
  };
  app.get('/contacts', async req => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100)), skip = Math.max(0, Number(req.query.skip) || 0);
    const filter = { deleted: { $ne:true } };
    if (req.query.listId) filter.listIds = String(req.query.listId);
    if (req.query.search) { const q = String(req.query.search).slice(0,100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(q,'i'); filter.$or = [{email:rx},{company:rx},{firstName:rx},{lastName:rx}]; }
    const total = await scoped('contacts', req.ctx).countDocuments(filter);
    const items = await scoped('contacts', req.ctx).find(filter, {limit,skip,sort:{createdAt:-1}});
    return { items, total, skip, limit };
  });

  app.post('/contacts', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const input = contactSchema.parse(req.body);
    input.listIds = await validLists(req.ctx, input.listIds);
    const result=await createContacts(req.ctx,[input]);
    const contact=result.created[0] || await scoped('contacts',req.ctx).findOne({email:input.email.toLowerCase().trim(),deleted:{$ne:true}});
    return { ...contact, existing: !result.created.length, addedToLists: result.addedToLists };
  });

  app.patch('/contacts/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const previous=await scoped('contacts',req.ctx).findOne({_id:req.params.id,deleted:{$ne:true}});
    if(!previous)throw notFound('Contact not found');
    if(req.body?.email!==undefined&&String(req.body.email).trim().toLowerCase()!==previous.email)
      throw badRequest('Contact email cannot be changed. Create a new contact instead.');
    const allowed=['firstName','lastName','company','customFields','phone','city','country','title','tags','listIds'];
    const changes=Object.fromEntries(Object.entries(req.body||{}).filter(([key])=>allowed.includes(key)));
    if(changes.listIds!==undefined)changes.listIds=await validLists(req.ctx,changes.listIds);
    if(changes.tags!==undefined){if(!Array.isArray(changes.tags)||changes.tags.length>50||changes.tags.some(t=>typeof t!=='string'||t.trim().length>80))throw badRequest('Choose at most 50 valid tags.');changes.tags=[...new Set(changes.tags.map(t=>t.trim()).filter(Boolean))];}
    await scoped('contacts',req.ctx).updateOne({_id:req.params.id},{$set:changes});
    const addedLists=(changes.listIds||[]).filter(id=>!(previous.listIds||[]).includes(id));
    const addedTags=(changes.tags||[]).filter(tag=>!(previous.tags||[]).some(old=>String(old).toLowerCase()===tag.toLowerCase()));
    if(addedLists.length)await recordAutomationTriggers({organizationId:req.ctx.organizationId,trigger:'contact_added',contactId:previous._id,listIds:addedLists,source:'contact_list_added'});
    if(addedTags.length)await recordAutomationTriggers({organizationId:req.ctx.organizationId,trigger:'tag_added',contactId:previous._id,tags:addedTags,source:'contact_tag_added'});
    return { ok: true };
  });

  app.delete('/contacts/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    await scoped('contacts', req.ctx).updateOne({ _id: req.params.id }, { $set: { deleted: true, deletedAt:new Date().toISOString(), listIds:[] } });
    return { ok: true };
  });

  // Actions operate only on explicitly selected IDs in the current workspace.
  app.post('/contacts/bulk-action', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const { action } = req.body || {};
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids)] : [];
    if (!ids.length || ids.length > 1000 || ids.some(x => typeof x !== 'string')) throw badRequest('Select between 1 and 1000 contacts.');
    if (!['delete','add_to_list'].includes(action)) throw badRequest('Choose a valid action.');
    let count=0;
    if(action==='add_to_list') await validLists(req.ctx,[req.body.listId]);
    for (const id of ids) {
      const before=action==='add_to_list'?await scoped('contacts',req.ctx).findOne({_id:id,deleted:{$ne:true}}):null;
      const result=await scoped('contacts',req.ctx).updateOne({ _id:id, deleted:{$ne:true} }, action==='delete'
        ? { $set:{deleted:true,deletedAt:new Date().toISOString(),listIds:[]} }
        : { $addToSet:{listIds:req.body.listId} });
      count+=result.matchedCount||0;
      if(before&&!((before.listIds||[]).includes(req.body.listId)))await recordAutomationTriggers({organizationId:req.ctx.organizationId,
        trigger:'contact_added',contactId:id,listIds:[req.body.listId],source:'contact_list_added'});
    }
    return {ok:true,matched:count};
  });

  /** Explicit category assignment — listIds come from the UI, never trust orgId from the client. */
  /**
   * Bulk contact write — used by CSV import and large seeds. One round trip per batch,
   * deterministic ids so a retried batch cannot create duplicates.
   */
  app.post('/contacts/bulk', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const rows = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    if (!rows.length) throw badRequest('No contacts in the request');
    if (rows.length > 10_000) throw badRequest('Send at most 10,000 contacts per batch');
    await validLists(req.ctx, [...new Set(rows.flatMap(row => Array.isArray(row.listIds) ? row.listIds : []))]);
    const now = new Date().toISOString();
    const docs = [];
    let skipped = 0;
    for (const row of rows) {
      const email = String(row.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { skipped += 1; continue; }
      docs.push({ _id: stableHash(req.ctx.organizationId, email), organizationId: req.ctx.organizationId,
        email, firstName: row.firstName || '', lastName: row.lastName || '', company: row.company || '',
        tags:Array.isArray(row.tags)?[...new Set(row.tags.filter(x=>typeof x==='string').map(x=>x.trim()).filter(x=>x&&x.length<=80))].slice(0,50):[],
        listIds: Array.isArray(row.listIds) ? row.listIds : [], dedupeKey: stableHash(req.ctx.organizationId, email),
        createdAt: now, updatedAt: now });
    }
    const result=await createContacts(req.ctx,docs);
    return { ok: true, added: result.created.length, skipped: skipped+result.duplicates };
  });

  app.post('/contacts/:id/lists', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const contact=await scoped('contacts',req.ctx).findOne({_id:req.params.id,deleted:{$ne:true}});
    if(!contact)throw notFound('Contact not found');
    const ids=await validLists(req.ctx,req.body.listIds||[]);
    await scoped('contacts',req.ctx).updateOne({_id:req.params.id},{$set:{listIds:ids}});
    const added=ids.filter(id=>!(contact.listIds||[]).includes(id));
    if(added.length)await recordAutomationTriggers({organizationId:req.ctx.organizationId,trigger:'contact_added',contactId:contact._id,
      listIds:added,source:'contact_list_added'});
    return {ok:true,listIds:ids};
  });

  app.post('/contacts/import', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const rows = Array.isArray(req.body.contacts) ? req.body.contacts : [];
    if (!rows.length) throw badRequest('contacts array required');
    const listIds = await validLists(req.ctx, req.body.listIds || []);
    if (rows.length > 50000) throw badRequest('Import at most 50,000 rows at a time.');
    if (rows.some(row => row.listIds !== undefined && !Array.isArray(row.listIds))) throw badRequest('Choose valid lists.');
    await validLists(req.ctx, [...new Set(rows.flatMap(row => row.listIds || []))]);
    // Small/medium CSV files are written synchronously so the UI can show the result immediately.
    if ((req.body.immediate === true && rows.length <= 2000) || rows.length <= 500) {
      let skipped = 0; const valid=[];
      for (const row of rows) {
        const parsed = contactSchema.safeParse({ ...row, listIds: [...new Set([...(row.listIds || []), ...listIds])] });
        if (!parsed.success) { skipped++; continue; }
        valid.push(parsed.data);
      }
      const result=await createContacts(req.ctx,valid);
      return { accepted: rows.length, created: result.created.length, existing: result.duplicates, addedToLists: result.addedToLists, restored: result.restored, invalid: skipped, skipped, job: 'done' };
    }
    const q = getQueue('import');
    await q.add('csv-import', { organizationId: req.ctx.organizationId, rows, listIds },
      { jobId: newId() });
    return { accepted: rows.length, job: 'queued' };
  });

  /** Lists with live contact counts — used as categories in the Contacts workspace. */
  app.get('/contacts/lists', async req => {
    const lists = await scoped('contact_lists', req.ctx).find({});
    // One indexed count per list — never load the audience to size it.
    return Promise.all(lists.map(async l => ({ ...l,
      count: await scoped('contacts', req.ctx).countDocuments({ deleted: { $ne: true }, listIds: l._id }) })));
  });

  app.post('/contacts/lists', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const name = listName(req.body.name);
    return scoped('contact_lists', req.ctx).create({ _id: newId(), name,
      description: String(req.body.description || '').slice(0, 240), color: req.body.color || '#2563eb' });
  });

  app.patch('/contacts/lists/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const set = {};
    if (req.body.name !== undefined) set.name = listName(req.body.name);
    if (req.body.description !== undefined) set.description = String(req.body.description).slice(0, 240);
    if (req.body.color !== undefined) set.color = String(req.body.color);
    await scoped('contact_lists', req.ctx).updateOne({ _id: req.params.id }, { $set: set });
    return { ok: true };
  });

  app.delete('/contacts/lists/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    await scoped('contact_lists', req.ctx).deleteOne({ _id: req.params.id });
    await scoped('contacts', req.ctx).updateMany({ listIds: req.params.id }, { $pull: { listIds: req.params.id } });
    return { ok: true };
  });
}
