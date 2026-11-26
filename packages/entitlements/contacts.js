import { effectiveAddons, limitFor } from './definitions.js';
import { collection, isMemoryMode, withMongoTransaction } from '../database/store.js';
import { AppError } from '../shared/errors.js';
import { newId, stableHash } from '../shared/utils.js';
import { makeAutomationTriggerEvent, publishAutomationTriggerEvents } from '../automations/triggers.js';

// All contact creation paths serialize by workspace. Existing emails gain the requested
// list memberships without overwriting their profile or consuming another contact slot.
const locks=new Map();
async function serial(key,work){
 const prior=locks.get(key)||Promise.resolve();let release;const next=new Promise(r=>release=r);locks.set(key,next);
 await prior;try{return await work();}finally{release();if(locks.get(key)===next)locks.delete(key);}
}
const limitError=(used,limit,requested)=>new AppError(402,'LIMIT_REACHED',`Contact limit reached (${used}/${limit}). Upgrade your plan or add contacts before importing more.`,{dimension:'contacts',used,limit,requested});

// Constant-Contact-style consent: every NEW contact carries a subscription
// status and an evidence record (who opted in, from where, under which text).
const consentSourceFor = x => x.consentSource
  || (String(x.source || '').startsWith('form:') ? 'website-form' : (x.source || 'manual'));

export async function createContacts(ctx, inputs, {deferAutomation=false}={}){
 if(!ctx?.organizationId)throw new Error('Workspace required');
 if(!Array.isArray(inputs)||inputs.length>20000)throw new Error('Invalid contact batch');
 const organizationId=ctx.organizationId, unique=new Map();
 for(const input of inputs){
  const email=String(input.email||'').trim().toLowerCase();if(!email)continue;
  const ids=Array.isArray(input.listIds)?input.listIds.map(String):[];
  const tags=Array.isArray(input.tags)?input.tags.map(x=>String(x).trim()).filter(Boolean):[];
  if(unique.has(email)){const old=unique.get(email);old.listIds=[...new Set([...(old.listIds||[]),...ids])];old.tags=[...new Set([...(old.tags||[]),...tags])];}
  else unique.set(email,{...input,email,listIds:[...new Set(ids)],tags:[...new Set(tags)]});
 }
 const now=new Date().toISOString();
 const build=x=>({...x,_id:newId(),organizationId,dedupeKey:stableHash(organizationId,x.email),createdAt:now,updatedAt:now,
   status: x.status || 'subscribed', consentAt: x.consentAt || now, consentSource: consentSourceFor(x)});
 const apply=async({org,findExisting,count,insert,merge,findSequences,findEvents,insertEvents})=>{
  if(!org&&!ctx.demo)throw new Error('Workspace not found');
  const plan=org?.plan||(ctx.demo?'growth':'free'),limit=limitFor(plan,'contacts',effectiveAddons(org));
  const found=await findExisting([...unique.keys()]), existing=new Map(found.map(x=>[String(x.email||'').toLowerCase(),x]));
  const docs=[...unique.values()].filter(x=>!existing.has(x.email)).map(build);
  const docsByEmail=new Map(docs.map(x=>[x.email,x]));
  const restored=[...unique.values()].filter(x=>existing.get(x.email)?.deleted===true);
  const used=await count(); if(limit>=0&&used+docs.length+restored.length>limit)throw limitError(used,limit,docs.length+restored.length);
  if(docs.length)await insert(docs);
 // Auto-record consent evidence for every newly created contact (tamper-proof
 // hash over org + email + source + text version — same as POST /consent).
 if(docs.length)for(const doc of docs){
   const version=String(doc.consentTextVersion||'v1');
   await collection('consent_records').create({_id:newId(),organizationId,email:doc.email,
     source:doc.consentSource,textVersion:version,ip:doc.consentIp||null,
     userAgent:doc.consentUserAgent||null,
     evidenceHash:stableHash(organizationId,doc.email,doc.consentSource,version),createdAt:now});
 }
  let addedToLists=0;
  for(const x of unique.values()){
   const previous=existing.get(x.email);if(!previous)continue;
   const ids=[...new Set([...(previous.deleted?[]:(previous.listIds||[])),...(x.listIds||[])])];
   const tags=[...new Set([...(previous.deleted?[]:(previous.tags||[])),...(x.tags||[])])];
   if(ids.length>(previous.listIds||[]).length)addedToLists++;
   if(ids.length>(previous.listIds||[]).length||tags.length>(previous.tags||[]).length||previous.deleted===true)await merge(previous,ids,tags);
  }

  // Persist trigger records in the same storage transaction as the contact/list writes.
  // Queue publication follows commit; schedulerSweep republishes any pending rows after
  // a crash or temporary queue outage. A flow/contact pair can enroll only once.
  const activeSequences=await findSequences();
  const triggerEvents=[];
  for(const x of unique.values()){
   const previous=existing.get(x.email), created=docsByEmail.get(x.email);
   const contact=created||previous;
   if(!contact)continue;
   const oldLists=new Set(previous?.deleted?[]:(previous?.listIds||[]).map(String));
   const newLists=x.listIds.map(String).filter(id=>!oldLists.has(id));
   const oldTags=new Set(previous?.deleted?[]:(previous?.tags||[]).map(t=>String(t).trim().toLowerCase()));
   const newTags=x.tags.map(t=>String(t).trim()).filter(t=>!oldTags.has(t.toLowerCase()));
   for(const sequence of activeSequences){
    if(sequence.trigger==='contact_added' && newLists.length && (!sequence.listId||newLists.includes(String(sequence.listId))))
     triggerEvents.push(makeAutomationTriggerEvent({organizationId,sequence,contactId:contact._id,source:'contact_added',details:{listIds:newLists}}));
    if(sequence.trigger==='tag_added' && newTags.length && (!sequence.triggerTag||newTags.some(t=>t.toLowerCase()===String(sequence.triggerTag).trim().toLowerCase())))
     triggerEvents.push(makeAutomationTriggerEvent({organizationId,sequence,contactId:contact._id,source:'tag_added',details:{tags:newTags}}));
   }
  }
  const eventIds=[];
  if(triggerEvents.length){
   const ids=triggerEvents.map(x=>x._id), prior=await findEvents(ids), priorById=new Map(prior.map(x=>[x._id,x]));
   const fresh=triggerEvents.filter(x=>!priorById.has(x._id));
   if(fresh.length)await insertEvents(fresh);
   for(const event of triggerEvents){const old=priorById.get(event._id);if(!old||old.status==='pending')eventIds.push(event._id);}
  }
  return {created:docs,duplicates:inputs.length-docs.length,addedToLists,restored:restored.length,used:used+docs.length+restored.length,limit,automationTriggerEventIds:[...new Set(eventIds)]};
 };
 let result;
 if(isMemoryMode())result=await serial(organizationId,async()=>{
  const col=collection('contacts'),sequences=collection('sequences'),events=collection('automation_trigger_events');
  return apply({org:await collection('organizations').findOne({_id:organizationId}),
   findExisting:emails=>col.find({organizationId,email:{$in:emails}}),
   count:()=>col.countDocuments({organizationId,deleted:{$ne:true}}),insert:docs=>col.insertMany(docs),
   merge:(old,ids,tags)=>col.updateOne({_id:old._id,organizationId},{$set:{listIds:ids,tags,deleted:false}}),
   findSequences:()=>sequences.find({organizationId,status:'active',executionEnabled:true,deleted:{$ne:true}}),
   findEvents:ids=>events.find({_id:{$in:ids}}),insertEvents:docs=>events.insertMany(docs)});
 });
 else result=await withMongoTransaction(async(db,session)=>{
  const orgs=db.collection('organizations'),contacts=db.collection('contacts');
  const locked=await orgs.updateOne({_id:organizationId},{$inc:{contactQuotaVersion:1}},{session});if(!locked.matchedCount)throw new Error('Workspace not found');
  return apply({org:await orgs.findOne({_id:organizationId},{session}),
   findExisting:emails=>contacts.find({organizationId,email:{$in:emails}},{session}).toArray(),
   count:()=>contacts.countDocuments({organizationId,deleted:{$ne:true}},{session}),
   insert:docs=>contacts.insertMany(docs,{session}),
   merge:(old,ids,tags)=>contacts.updateOne({_id:old._id,organizationId},{$addToSet:{listIds:{$each:ids},tags:{$each:tags}},$set:{deleted:false,updatedAt:now}},{session}),
   findSequences:()=>db.collection('sequences').find({organizationId,status:'active',executionEnabled:true,deleted:{$ne:true}},{session}).toArray(),
   findEvents:ids=>db.collection('automation_trigger_events').find({_id:{$in:ids}},{session}).toArray(),
   insertEvents:docs=>db.collection('automation_trigger_events').insertMany(docs,{session})});
 });
 if(!deferAutomation&&result.automationTriggerEventIds?.length){
  try{await publishAutomationTriggerEvents(result.automationTriggerEventIds);}
  catch(error){console.warn('[automation] contact trigger saved; queue publish deferred to scheduler sweep.',String(error?.code||'QUEUE_UNAVAILABLE'));}
 }
 return result;
}
