import { effectiveAddons, limitFor } from './definitions.js';
import { collection, isMemoryMode, withMongoTransaction } from '../database/store.js';
import { AppError } from '../shared/errors.js';
import { newId, stableHash } from '../shared/utils.js';

// All contact creation paths serialize by workspace. Existing emails gain the requested
// list memberships without overwriting their profile or consuming another contact slot.
const locks=new Map();
async function serial(key,work){
 const prior=locks.get(key)||Promise.resolve();let release;const next=new Promise(r=>release=r);locks.set(key,next);
 await prior;try{return await work();}finally{release();if(locks.get(key)===next)locks.delete(key);}
}
const limitError=(used,limit,requested)=>new AppError(402,'LIMIT_REACHED',`Contact limit reached (${used}/${limit}). Upgrade your plan or add contacts before importing more.`,{dimension:'contacts',used,limit,requested});
export async function createContacts(ctx, inputs){
 if(!ctx?.organizationId)throw new Error('Workspace required');
 if(!Array.isArray(inputs)||inputs.length>20000)throw new Error('Invalid contact batch');
 const organizationId=ctx.organizationId, unique=new Map();
 for(const input of inputs){
  const email=String(input.email||'').trim().toLowerCase();if(!email)continue;
  const ids=Array.isArray(input.listIds)?input.listIds.map(String):[];
  if(unique.has(email)){const old=unique.get(email);old.listIds=[...new Set([...(old.listIds||[]),...ids])];}
  else unique.set(email,{...input,email,listIds:[...new Set(ids)]});
 }
 const now=new Date().toISOString();
 const build=x=>({...x,_id:newId(),organizationId,dedupeKey:stableHash(organizationId,x.email),createdAt:now,updatedAt:now});
 const apply=async({org,findExisting,count,insert,merge})=>{
  if(!org&&!ctx.demo)throw new Error('Workspace not found');
  const plan=org?.plan||(ctx.demo?'growth':'free'),limit=limitFor(plan,'contacts',effectiveAddons(org));
  const found=await findExisting([...unique.keys()]), existing=new Map(found.map(x=>[String(x.email||'').toLowerCase(),x]));
  const docs=[...unique.values()].filter(x=>!existing.has(x.email)).map(build);
  const restored=[...unique.values()].filter(x=>existing.get(x.email)?.deleted===true);
  const used=await count(); if(limit>=0&&used+docs.length+restored.length>limit)throw limitError(used,limit,docs.length+restored.length);
  if(docs.length)await insert(docs);
  let addedToLists=0;
  for(const x of unique.values()){
   const previous=existing.get(x.email);if(!previous)continue;
   const ids=[...new Set([...(previous.listIds||[]),...(x.listIds||[])])];
   if(ids.length>(previous.listIds||[]).length)addedToLists++;
   if(ids.length>(previous.listIds||[]).length || previous.deleted===true)await merge(previous,ids);
  }
  return {created:docs,duplicates:inputs.length-docs.length,addedToLists,restored:restored.length,used:used+docs.length+restored.length,limit};
 };
 if(isMemoryMode())return serial(organizationId,async()=>{
  const col=collection('contacts');
  return apply({org:await collection('organizations').findOne({_id:organizationId}),findExisting:emails=>col.find({organizationId,email:{$in:emails}}),
    count:()=>col.countDocuments({organizationId,deleted:{$ne:true}}),insert:docs=>col.insertMany(docs),
    merge:(old,ids)=>col.updateOne({_id:old._id,organizationId},{$set:{listIds:ids,deleted:false}})});
 });
 return withMongoTransaction(async(db,session)=>{
  const orgs=db.collection('organizations'),contacts=db.collection('contacts');
  const locked=await orgs.updateOne({_id:organizationId},{$inc:{contactQuotaVersion:1}},{session});if(!locked.matchedCount)throw new Error('Workspace not found');
  return apply({org:await orgs.findOne({_id:organizationId},{session}),findExisting:emails=>contacts.find({organizationId,email:{$in:emails}},{session}).toArray(),
   count:()=>contacts.countDocuments({organizationId,deleted:{$ne:true}},{session}),insert:docs=>contacts.insertMany(docs,{session}),
   merge:(old,ids)=>contacts.updateOne({_id:old._id,organizationId},{$addToSet:{listIds:{$each:ids}},$set:{deleted:false,updatedAt:now}},{session})});
 });
}
