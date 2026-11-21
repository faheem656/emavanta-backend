// Precise legacy seed identities, not an email/domain-wide deletion rule.
const legacy=[
 {_id:'demo-user',email:'owner@emavanta.com',name:'Dana Nguyen'},
 {_id:'demo-user-leo',email:'leo@northwind.com',name:'Leo Park'},
 {_id:'demo-user-maya',email:'maya@northwind.com',name:'Maya Silva'}
];
export async function inspectLegacyDemo(db,{ownerEmail='',session}={}){
 const options=session?{session}:{};const result=[];
 for(const seed of legacy){
  const user=await db.collection('users').findOne({_id:seed._id},options);
  if(!user){result.push({id:seed._id,status:'absent'});continue;}
  let reason='';
  const originalKeys=new Set(['_id','email','name','emailVerified','mfaEnabled','createdAt']);
  if(user.email!==seed.email||user.name!==seed.name||user.emailVerified!==true||user.mfaEnabled!==false||Object.keys(user).some(k=>!originalKeys.has(k)))reason='record differs from the original seed';
  else if(seed.email.toLowerCase()===String(ownerEmail||'').trim().toLowerCase())reason='matches configured platform owner';
  else if(await db.collection('memberships').findOne({userId:seed._id,organizationId:{$ne:'demo-org'}},options))reason='has membership outside demo workspace';
  else if(await db.collection('organizations').findOne({ownerId:seed._id,_id:{$ne:'demo-org'}},options))reason='owns another workspace';
  else if(await db.collection('sessions').findOne({userId:seed._id},options))reason='has session activity';
  else if(await db.collection('api_keys').findOne({createdBy:seed._id},options))reason='has API keys';
  else if(seed._id==='demo-user'&&await db.collection('memberships').findOne({organizationId:'demo-org',userId:{$nin:legacy.map(x=>x._id)}},options))reason='demo workspace has other members';
  result.push({id:seed._id,status:reason?'protected':'eligible',...(reason?{reason}:{})});
 }
 return result;
}
export async function removeLegacyDemo(db,{ownerEmail='',session}={}){
 if(!session)throw new Error('Transactional cleanup required');
 const results=await inspectLegacyDemo(db,{ownerEmail,session});
 for(const row of results.filter(x=>x.status==='eligible')){
  await db.collection('memberships').deleteMany({userId:row.id,organizationId:'demo-org'},{session});
  await db.collection('sessions').deleteMany({userId:row.id,organizationId:'demo-org'},{session});
  await db.collection('api_keys').deleteMany({createdBy:row.id,organizationId:'demo-org'},{session});
  await db.collection('users').deleteOne({_id:row.id},{session});
  row.status='removed';
 }
 return results;
}
