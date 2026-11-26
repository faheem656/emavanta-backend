import { collection, scoped, isMemoryMode, nativeDatabase, withMongoTransaction } from '../../../../packages/database/store.js';
import { registerWorker } from '../../../../packages/queue/index.js';
import { enqueueAutomationStep } from '../../../../packages/automations/jobs.js';
import { evaluateAutomationCondition } from '../../../../packages/automations/matching.js';
import { sendMessage } from '../../../../packages/providers/index.js';
import { renderMessage } from '../../../../packages/email-engine/render.js';
import { acquireStream } from '../../../../packages/rate-limiter/index.js';
import { throughputFor } from '../../../../packages/deliverability/index.js';
import { effectiveAddons, limitFor } from '../../../../packages/entitlements/definitions.js';
import { usageLedgerId } from '../../../../packages/entitlements/metering.js';
import { whiteLabelFor } from '../../../../packages/entitlements/branding.js';
import { expireCryptoSubscription } from '../payments/crypto-service.js';
import { stableHash } from '../../../../packages/shared/utils.js';
import { automationEnrollmentIdFor, automationStepRunIdFor } from '../../../../packages/automations/identity.js';

const nowIso = () => new Date().toISOString();
const terminal = new Set(['completed','stopped','suppressed','cancelled','needs_review']);
const count = async (ctx, filter) => scoped('messages',ctx).countDocuments(filter);

async function insertIfAbsent(name, doc) {
  if (isMemoryMode()) {
    const old = await collection(name).findOne({ _id: doc._id });
    return old || collection(name).create(doc);
  }
  try { await nativeDatabase().collection(name).insertOne(doc); return doc; }
  catch (error) {
    if (error?.code !== 11000) throw error;
    return collection(name).findOne({ _id: doc._id });
  }
}

async function ensureStepRun(ctx, enrollment, index, step) {
  const _id = automationStepRunIdFor(enrollment._id,index);
  return insertIfAbsent('sequence_step_runs', { _id, organizationId:ctx.organizationId,
    sequenceId:enrollment.sequenceId, enrollmentId:enrollment._id, contactId:enrollment.contactId,
    stepIndex:index, type:step.type, status:'queued', createdAt:nowIso(), updatedAt:nowIso() });
}

async function updateRun(ctx, runId, filter, values) {
  return scoped('sequence_step_runs',ctx).updateOne({ _id:runId, ...filter }, { $set:{...values,updatedAt:nowIso()} });
}

async function markNeedsReview(ctx, enrollment, reason, runId, runStatus = 'blocked') {
  if (runId) await updateRun(ctx,runId,{}, {status:runStatus,reason,reviewAt:nowIso()});
  await scoped('sequence_enrollments',ctx).updateOne({ _id:enrollment._id }, { $set:{status:'needs_review',reviewReason:reason,
    lastErrorCode:reason,needsReviewAt:nowIso(),updatedAt:nowIso()} });
}

async function advance(ctx, sequence, enrollment, nextStepIndex, runAt = nowIso()) {
  if (nextStepIndex >= sequence.steps.length) {
    await scoped('sequence_enrollments',ctx).updateOne({ _id:enrollment._id }, { $set:{status:'completed',
      currentStep:sequence.steps.length,nextRunAt:null,completedAt:nowIso(),updatedAt:nowIso()} });
    return;
  }
  const target = Date.parse(runAt) > Date.now() ? new Date(runAt).toISOString() : nowIso();
  await scoped('sequence_enrollments',ctx).updateOne({ _id:enrollment._id }, { $set:{status:Date.parse(target)>Date.now()?'waiting':'queued',
    currentStep:nextStepIndex,nextRunAt:target,updatedAt:nowIso()} });
  await enqueueAutomationStep({ organizationId:ctx.organizationId,sequenceId:sequence._id,
    enrollmentId:enrollment._id,stepIndex:nextStepIndex,runAt:target });
}

async function finishTrigger(payload) {
  const { organizationId, triggerEventId } = payload;
  const ctx={organizationId}, events=collection('automation_trigger_events');
  const event=await events.findOne({ _id:triggerEventId, organizationId });
  if (!event || ['processed','skipped','cancelled'].includes(event.status)) return;
  const sequence=await scoped('sequences',ctx).findOne({ _id:event.sequenceId });
  if (!sequence || sequence.deleted) {
    await events.updateOne({ _id:triggerEventId,organizationId }, { $set:{status:'cancelled',updatedAt:nowIso()} }); return;
  }
  if (sequence.status!=='active' || sequence.executionEnabled!==true) {
    await events.updateOne({ _id:triggerEventId,organizationId }, { $set:{status:'deferred',deferredAt:nowIso(),leaseUntil:null,updatedAt:nowIso()} }); return;
  }
  const claim=await events.updateOne({ _id:triggerEventId,organizationId,$or:[
    {status:'pending'}, {status:'processing',leaseUntil:{$lte:nowIso()}}
  ] }, { $set:{status:'processing',leaseUntil:new Date(Date.now()+60000).toISOString(),updatedAt:nowIso()},$inc:{attempts:1} });
  if (!claim.matchedCount) return;
  try {
    const contact=await scoped('contacts',ctx).findOne({ _id:event.contactId,deleted:{$ne:true} });
    if (!contact || !contact.email || contact.status==='unsubscribed' || contact.status==='bounced') {
      await events.updateOne({ _id:triggerEventId,organizationId }, { $set:{status:'skipped',
        skipReason: contact?.status==='bounced' ? 'contact_bounced' : 'contact_unavailable',
        leaseUntil:null,updatedAt:nowIso()} }); return;
    }
    const suppression=await scoped('suppressions',ctx).findOne({ email:String(contact.email).toLowerCase(),status:{$ne:'expired'} });
    if (suppression) {
      await events.updateOne({ _id:triggerEventId,organizationId }, { $set:{status:'skipped',skipReason:'suppressed',leaseUntil:null,updatedAt:nowIso()} }); return;
    }
    const _id=automationEnrollmentIdFor(organizationId,sequence._id,contact._id);
    const enrollment=await insertIfAbsent('sequence_enrollments',{_id,organizationId,sequenceId:sequence._id,contactId:contact._id,
      contactEmail:contact.email,source:event.source||event.trigger,triggerEventId,status:'queued',currentStep:0,
      stepsSnapshot:sequence.steps.map(step=>({...step})),defaultAccountSnapshot:sequence.accountId||null,
      nextRunAt:nowIso(),enrolledAt:nowIso(),updatedAt:nowIso()});
    if (!terminal.has(enrollment.status) && enrollment.status!=='paused') {
      const index=Number.isInteger(enrollment.currentStep)?enrollment.currentStep:0;
      await enqueueAutomationStep({organizationId,sequenceId:sequence._id,enrollmentId:enrollment._id,stepIndex:index,
        runAt:enrollment.nextRunAt||nowIso()});
    }
    await events.updateOne({ _id:triggerEventId,organizationId }, { $set:{status:'processed',processedAt:nowIso(),leaseUntil:null,updatedAt:nowIso()} });
  } catch (error) {
    await events.updateOne({ _id:triggerEventId,organizationId }, { $set:{status:'pending',leaseUntil:null,lastErrorCode:String(error?.code||'TRIGGER_FAILED').slice(0,80),updatedAt:nowIso()} });
    throw error;
  }
}

async function quotaReserve(ctx, org) {
  const plan=org?.plan||'free', addons=effectiveAddons(org), limit=limitFor(plan,'sends',addons);
  if (limit<0) return {ok:true};
  const cycle=org?.cycle||new Date().toISOString().slice(0,7), id=usageLedgerId(ctx.organizationId,cycle);
  if (isMemoryMode()) {
    let row=await collection('usage_counters').findOne({_id:id});
    if(!row)row=await collection('usage_counters').create({_id:id,organizationId:ctx.organizationId,cycle,sends:0});
    const used=Math.max(Number(row.sends||0),await count(ctx,{}));
    if(used>=limit)return {ok:false,limit,used};
    await collection('usage_counters').updateOne({_id:id},{$set:{sends:used+1}});return {ok:true};
  }
  const col=nativeDatabase().collection('usage_counters');
  await col.updateOne({_id:id},{$setOnInsert:{organizationId:ctx.organizationId,cycle,sends:0}},{upsert:true});
  const messages=await count(ctx,{});await col.updateOne({_id:id},{$max:{sends:messages}});
  const used=await collection('usage_counters').findOne({_id:id});
  const reserved=await col.updateOne({_id:id,sends:{$lt:limit}},{$inc:{sends:1}});
  return reserved.modifiedCount?{ok:true}:{ok:false,limit,used:Number(used?.sends||messages)};
}

async function sentToday(ctx, accountId) {
  const start=new Date();start.setUTCHours(0,0,0,0);
  return count(ctx,{sendingAccountId:accountId,sentAt:{$gte:start.toISOString()}});
}

async function saveAccepted({ctx,sequence,enrollment,step,index,account,contact,template,message,result,runId}) {
  const sentAt=nowIso(), eventId=`automation-sent-${message.id}`;
  const event={_id:eventId,organizationId:ctx.organizationId,sequenceId:sequence._id,automationId:sequence._id,
    automationEnrollmentId:enrollment._id,sequenceStepIndex:index,campaignId:message.campaignId,messageId:message.id,
    contactId:contact._id,email:contact.email,sendingAccountId:account._id,provider:account.authMethod,
    type:'sent',dedupeKey:`sent:${message.id}`,providerMessageId:result.providerMessageId,createdAt:sentAt};
  const messageRow={...message,_id:stableHash('message-row',message.id),organizationId:ctx.organizationId,status:'sent',
    providerMessageId:result.providerMessageId,sentAt,sequenceId:sequence._id,automationEnrollmentId:enrollment._id,sequenceStepIndex:index};
  const snapshot={_id:stableHash('message-snapshot',message.id),organizationId:ctx.organizationId,messageId:message.id,
    sequenceId:sequence._id,automationEnrollmentId:enrollment._id,sequenceStepIndex:index,subject:message.subject,
    html:message.html,templateVersion:message.templateVersion,createdAt:sentAt};
  const runPatch={status:'sent',sentAt,messageId:message.id,providerMessageId:result.providerMessageId,
    nextStepIndex:index+1,nextRunAt:sentAt,reason:null};
  if(isMemoryMode()){
    await collection('messages').create(messageRow);await collection('message_snapshots').create(snapshot);
    await collection('delivery_events').create(event);await updateRun(ctx,runId,{},runPatch);
    if(account.authMethod==='mock'&&process.env.NODE_ENV==='test')await collection('delivery_events').create({...event,_id:`automation-delivered-${message.id}`,type:'delivered',dedupeKey:`delivered:${message.id}`});
    await scoped('sending_accounts',ctx).updateOne({_id:account._id},{$inc:{sentToday:1}});return;
  }
  await withMongoTransaction(async(db,session)=>{
    await db.collection('messages').insertOne(messageRow,{session});
    await db.collection('message_snapshots').insertOne(snapshot,{session});
    await db.collection('delivery_events').insertOne(event,{session});
    await db.collection('sequence_step_runs').updateOne({_id:runId,status:'sending'},{$set:{...runPatch,updatedAt:sentAt}},{session});
    if(account.authMethod==='mock'&&process.env.NODE_ENV==='test')await db.collection('delivery_events').insertOne({...event,_id:`automation-delivered-${message.id}`,type:'delivered',dedupeKey:`delivered:${message.id}`},{session});
    await db.collection('sending_accounts').updateOne({_id:account._id,organizationId:ctx.organizationId},{$inc:{sentToday:1}},{session});
  });
}

async function evaluateCondition(ctx,enrollment,sequence,contact) {
  const priorRuns=await scoped('sequence_step_runs',ctx).find({enrollmentId:enrollment._id,type:'email',status:'sent'});
  const earliest=priorRuns.map(x=>x.sentAt).filter(Boolean).sort()[0]||'9999';
  const replies=await scoped('sequence_pauses',ctx).find({$or:[{contactId:contact._id},{email:contact.email}],createdAt:{$gte:earliest}});
  const replied=replies.length>0;
  const opened=!!(await scoped('delivery_events',ctx).findOne({automationEnrollmentId:enrollment._id,type:'opened'}));
  const clicked=!!(await scoped('delivery_events',ctx).findOne({automationEnrollmentId:enrollment._id,type:'clicked'}));
  return evaluateAutomationCondition(sequence.steps[enrollment.currentStep]?.condition,{replied,opened,clicked});
}

async function sendAutomationEmail(ctx,sequence,enrollment,contact,step,index,runId) {
  let org=await collection('organizations').findOne({_id:ctx.organizationId});
  if(!isMemoryMode())org=await expireCryptoSubscription(ctx.organizationId);
  const plan=org?.plan||(ctx.demo?'growth':'free');
  const accounts=await scoped('sending_accounts',ctx).find({status:'active'});
  const accountId=step.accountId||sequence.accountId;
  const account=accounts.find(a=>a._id===accountId);
  if(!account){await markNeedsReview(ctx,enrollment,'mailbox_unavailable',runId,'blocked');return;}
  const template=await scoped('templates',ctx).findOne({_id:step.templateId});
  if(!template){await markNeedsReview(ctx,enrollment,'template_unavailable',runId,'blocked');return;}
  const suppression=await scoped('suppressions',ctx).findOne({email:String(contact.email).toLowerCase(),status:{$ne:'expired'}});
  if(suppression){await scoped('sequence_enrollments',ctx).updateOne({_id:enrollment._id},{$set:{status:'suppressed',reviewReason:'suppressed',completedAt:nowIso()}});return;}

  const limit=Number(account.dailyCap)||50;
  if(await sentToday(ctx,account._id)>=limit){
    const next=new Date();next.setUTCHours(24,5,0,0);await updateRun(ctx,runId,{status:'queued'},{status:'queued',reason:'daily_cap'});
    await advance(ctx,sequence,enrollment,index,next.toISOString());return;
  }
  const throughput=throughputFor(plan);
  try{
    const rate=await acquireStream({organizationId:ctx.organizationId,stream:'marketing',accountId:account._id,
      domain:String(account.fromEmail||'').split('@')[1]||'unknown',streamCapacity:throughput.burst,streamRefill:throughput.refillPerSec,
      accountCapacity:10,accountRefill:0.2,domainCapacity:throughput.burst*2,domainRefill:throughput.refillPerSec*2});
    if(!rate.ok){const at=new Date(Date.now()+Math.max(1000,(rate.retryAfter||5)*1000)).toISOString();
      await updateRun(ctx,runId,{status:'queued'},{status:'queued',reason:'rate_limited'});await advance(ctx,sequence,enrollment,index,at);return;}
  }catch(error){await updateRun(ctx,runId,{status:'sending'},{status:'queued',reason:'rate_limiter_unavailable'});throw error;}
  const reserved=await quotaReserve(ctx,org);
  if(!reserved.ok){await markNeedsReview(ctx,enrollment,'send_quota_exhausted',runId,'blocked');return;}

  const campaignId=`automation-${sequence._id}-${enrollment._id}-step-${index}`;
  const message=renderMessage({template:{...template,subject:step.subject||template.subject},
    recipient:{...contact,_id:contact._id,email:contact.email},account,
    campaign:{_id:campaignId,organizationId:ctx.organizationId,automationId:sequence._id,
      automationEnrollmentId:enrollment._id,sequenceStepIndex:index},organizationId:ctx.organizationId,
    includeEmavantaBrand:!whiteLabelFor(org)});
  message.sequenceId=sequence._id;message.automationEnrollmentId=enrollment._id;message.sequenceStepIndex=index;
  const claimed=await updateRun(ctx,runId,{status:'queued'},{status:'sending',sendingAt:nowIso(),
    sendingLeaseUntil:new Date(Date.now()+60000).toISOString(),reason:null});
  if(!claimed.matchedCount){const existing=await scoped('sequence_step_runs',ctx).findOne({_id:runId});
    if(existing?.status==='sent')return advance(ctx,sequence,enrollment,index+1,existing.nextRunAt||nowIso());
    if(existing?.status==='sending')return;
    return;
  }
  let result;
  try{result=await sendMessage(account,message);}
  catch(error){
    // SMTP/provider errors can occur after acceptance. Never auto-send an ambiguous
    // step again; ask the operator to reconcile and choose an explicit recovery action.
    await updateRun(ctx,runId,{status:'sending'},{status:'delivery_unknown',reason:'provider_outcome_unknown',
      errorCode:String(error?.code||'PROVIDER_ERROR').slice(0,80),reviewAt:nowIso()});
    await scoped('sequence_enrollments',ctx).updateOne({_id:enrollment._id},{$set:{status:'needs_review',reviewReason:'provider_outcome_unknown',
      lastErrorCode:String(error?.code||'PROVIDER_ERROR').slice(0,80),needsReviewAt:nowIso()}});
    return;
  }
  await saveAccepted({ctx,sequence,enrollment,step,index,account,contact,template,message,result,runId});
  const sentRun=await scoped('sequence_step_runs',ctx).findOne({_id:runId});
  await advance(ctx,sequence,enrollment,index+1,sentRun?.nextRunAt||nowIso());
}

async function processStep(payload) {
  const {organizationId,sequenceId,enrollmentId,stepIndex}=payload,ctx={organizationId};
  const enrollment=await scoped('sequence_enrollments',ctx).findOne({_id:enrollmentId,sequenceId});
  if(!enrollment||terminal.has(enrollment.status)||enrollment.status==='paused')return;
  const sequence=await scoped('sequences',ctx).findOne({_id:sequenceId});
  if(!sequence||sequence.deleted){await scoped('sequence_enrollments',ctx).updateOne({_id:enrollmentId},{$set:{status:'cancelled',completedAt:nowIso()}});return;}
  if(sequence.status!=='active'||sequence.executionEnabled!==true){await scoped('sequence_enrollments',ctx).updateOne({_id:enrollmentId},{$set:{status:'paused',pausedAt:nowIso()}});return;}
  const flow={...sequence,steps:Array.isArray(enrollment.stepsSnapshot)?enrollment.stepsSnapshot:sequence.steps,
    accountId:enrollment.defaultAccountSnapshot??sequence.accountId};
  if(stepIndex<enrollment.currentStep){
    const nextAt=enrollment.nextRunAt||nowIso();
    if(!terminal.has(enrollment.status))await enqueueAutomationStep({organizationId,sequenceId,enrollmentId,stepIndex:enrollment.currentStep,runAt:nextAt});
    return;
  }
  if(stepIndex>enrollment.currentStep)return;
  const runAt=Date.parse(enrollment.nextRunAt||0);
  if(Number.isFinite(runAt)&&runAt>Date.now())return enqueueAutomationStep({organizationId,sequenceId,enrollmentId,stepIndex,runAt:enrollment.nextRunAt});
  if(stepIndex>=flow.steps.length){await advance(ctx,flow,enrollment,flow.steps.length);return;}
  await scoped('sequence_enrollments',ctx).updateOne({_id:enrollmentId,status:{$in:['queued','waiting','running']}},{$set:{status:'running',lastStartedAt:nowIso()}});
  const contact=await scoped('contacts',ctx).findOne({_id:enrollment.contactId,deleted:{$ne:true}});
  if(!contact||contact.status==='unsubscribed'){await scoped('sequence_enrollments',ctx).updateOne({_id:enrollmentId},{$set:{status:'cancelled',reviewReason:'contact_unavailable',completedAt:nowIso()}});return;}
  const step=flow.steps[stepIndex],runId=automationStepRunIdFor(enrollmentId,stepIndex);
  const run=await ensureStepRun(ctx,enrollment,stepIndex,step);
  if(run.status==='sent'||run.status==='completed')return advance(ctx,flow,enrollment,run.nextStepIndex??stepIndex+1,run.nextRunAt||nowIso());
  if(run.status==='delivery_unknown'||run.status==='blocked'){
    await scoped('sequence_enrollments',ctx).updateOne({_id:enrollmentId},{$set:{status:'needs_review',reviewReason:run.reason||'step_needs_review'}});return;
  }
  if(run.status==='sending'){
    // The worker lease expired while a provider request was in flight. Treat as
    // ambiguous rather than risking a duplicate email.
    await updateRun(ctx,runId,{status:'sending'},{status:'delivery_unknown',reason:'worker_lost_during_send',reviewAt:nowIso()});
    await scoped('sequence_enrollments',ctx).updateOne({_id:enrollmentId},{$set:{status:'needs_review',reviewReason:'provider_outcome_unknown',needsReviewAt:nowIso()}});return;
  }
  if(step.type==='delay'){
    const minutes=Number(step.delayMinutes);
    if(!Number.isInteger(minutes)||minutes<1){await markNeedsReview(ctx,enrollment,'invalid_delay',runId,'blocked');return;}
    const at=new Date(Date.now()+minutes*60_000).toISOString();
    await updateRun(ctx,runId,{status:'queued'},{status:'completed',completedAt:nowIso(),nextStepIndex:stepIndex+1,nextRunAt:at});
    return advance(ctx,flow,enrollment,stepIndex+1,at);
  }
  if(step.type==='condition'){
    const result=await evaluateCondition(ctx,enrollment,flow,contact);
    if(!result.known){await markNeedsReview(ctx,enrollment,'unsupported_condition',runId,'blocked');return;}
    await updateRun(ctx,runId,{status:'queued'},{status:'completed',completedAt:nowIso(),conditionResult:result.continue?'continued':'stopped',reason:result.reason});
    if(!result.continue){await scoped('sequence_enrollments',ctx).updateOne({_id:enrollmentId},{$set:{status:'stopped',
      stopReason:result.reason||'condition_false',completedAt:nowIso(),currentStep:stepIndex+1}});return;}
    return advance(ctx,flow,enrollment,stepIndex+1,nowIso());
  }
  if(step.type==='tag'){
    const tags=(Array.isArray(step.tags)?step.tags:[]).map(t=>String(t).trim()).filter(Boolean);
    if(!tags.length){await markNeedsReview(ctx,enrollment,'invalid_tag_step',runId,'blocked');return;}
    const current=Array.isArray(contact.tags)?contact.tags:[];
    const added=tags.filter(t=>!current.includes(t));
    const merged=[...current,...added];
    await scoped('contacts',ctx).updateOne({_id:contact._id},{$set:{tags:merged,updatedAt:nowIso()}});
    // Chained workflows: adding a tag can itself start another automation.
    if(added.length){try{
      const { recordAutomationTriggers, publishAutomationTriggerEvents } = await import('../../../../packages/automations/triggers.js');
      const res=await recordAutomationTriggers({organizationId:ctx.organizationId,trigger:'tag_added',
        contactId:contact._id,tags:added,source:'automation_tag_step'});
      if(res?.eventIds?.length)await publishAutomationTriggerEvents(res.eventIds);
    }catch{ /* sweep republishes pending trigger rows */ }}
    await updateRun(ctx,runId,{status:'queued'},{status:'completed',completedAt:nowIso(),nextStepIndex:stepIndex+1,nextRunAt:nowIso()});
    return advance(ctx,flow,enrollment,stepIndex+1,nowIso());
  }
  if(step.type!=='email'){await markNeedsReview(ctx,enrollment,'unsupported_step',runId,'blocked');return;}
  await sendAutomationEmail(ctx,flow,enrollment,contact,step,stepIndex,runId);
}

export const startAutomationRunner = () => registerWorker('automation', async (payload,job) => {
  if(job?.name==='automation.trigger'||payload.triggerEventId)return finishTrigger(payload);
  if(job?.name==='automation.step'||payload.enrollmentId)return processStep(payload);
});
