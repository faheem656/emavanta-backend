import { collection, scoped, isMemoryMode } from '../../../../packages/database/store.js';
import { assertPermission, PERMISSIONS } from '../../../../packages/security/rbac.js';
import { sequenceSchema } from '../../../../packages/validation/index.js';
import { newId } from '../../../../packages/shared/utils.js';
import { badRequest, notFound } from '../../../../packages/shared/errors.js';
import { effectiveAddons, limitFor } from '../../../../packages/entitlements/definitions.js';
import { blocksToHtml } from '../../../../packages/email-engine/template.js';
import { preflight } from '../../../../packages/email-engine/preflight.js';
import { evaluateAutomationCondition } from '../../../../packages/automations/matching.js';
import { recordAutomationTriggerForSequence, publishAutomationTriggerEvents } from '../../../../packages/automations/triggers.js';
import { enqueueAutomationStep } from '../../../../packages/automations/jobs.js';
import { automationEnrollmentIdFor, automationStepRunIdFor } from '../../../../packages/automations/identity.js';

const nowIso=()=>new Date().toISOString();
const activeFilter={status:'active',executionEnabled:true,deleted:{$ne:true}};
const accountIsUsable=a=>a?.status==='active' && (a.authMethod!=='mock'||process.env.NODE_ENV==='test');

async function validateForActivation(ctx, sequence) {
  const parsed=sequenceSchema.safeParse(sequence);
  if(!parsed.success)throw badRequest(`Workflow configuration is invalid: ${parsed.error.issues[0]?.message||'check the fields.'}`);
  if(!['manual','contact_added','form_submitted','tag_added','api'].includes(sequence.trigger||'manual'))throw badRequest('Choose a supported workflow trigger.');
  if(sequence.trigger==='contact_added'&&sequence.listId&&!await scoped('contact_lists',ctx).findOne({_id:sequence.listId}))throw badRequest('The selected trigger list no longer exists.');
  if(sequence.trigger==='form_submitted'&&sequence.formId&&!await scoped('forms',ctx).findOne({_id:sequence.formId,deleted:{$ne:true}}))throw badRequest('The selected trigger form no longer exists.');
  const emails=sequence.steps.filter(s=>s.type==='email');
  if(!emails.length)throw badRequest('Add at least one email step before activation.');
  const org=await collection('organizations').findOne({_id:ctx.organizationId});
  const plan=org?.plan||(ctx.demo?'growth':'free'), automationLimit=limitFor(plan,'automations',effectiveAddons(org));
  const active=await scoped('sequences',ctx).countDocuments(activeFilter);
  if(sequence.status!=='active'&&automationLimit>=0&&active>=automationLimit)
    throw badRequest(`Your ${plan} plan allows ${automationLimit} active automation(s). Upgrade or pause another automation.`);
  let hadEmail=false,waitAfterEmail=0;
  for(let i=0;i<sequence.steps.length;i++){
    const step=sequence.steps[i];
    if(step.type==='delay'){
      if(!Number.isInteger(step.delayMinutes)||step.delayMinutes<1)throw badRequest(`Wait step ${i+1} needs a delay of at least one minute.`);
      if(hadEmail)waitAfterEmail+=step.delayMinutes;
      continue;
    }
    if(step.type==='condition'){
      if(!hadEmail)throw badRequest(`Condition step ${i+1} needs an earlier email.`);
      if(waitAfterEmail<30)throw badRequest(`Add at least a 30-minute wait before condition step ${i+1}, so opens/replies can arrive.`);
      if(!evaluateAutomationCondition(step.condition,{replied:false,opened:false,clicked:false}).known)throw badRequest(`Condition step ${i+1} is not supported.`);
      continue;
    }
    if(step.type!=='email')throw badRequest(`Step ${i+1} has an unsupported type.`);
    if(hadEmail&&waitAfterEmail<5)throw badRequest(`Add a wait of at least five minutes between email steps (step ${i+1}).`);
    if(typeof step.templateId!=='string'||!step.templateId.trim())throw badRequest(`Choose an email template for step ${i+1}.`);
    const template=await scoped('templates',ctx).findOne({_id:step.templateId});
    if(!template)throw badRequest(`The template for step ${i+1} was deleted or is unavailable.`);
    const accountId=step.accountId||sequence.accountId;
    if(!accountId)throw badRequest(`Choose a default sending mailbox or a mailbox override for email step ${i+1}.`);
    const account=await scoped('sending_accounts',ctx).findOne({_id:accountId});
    if(!accountIsUsable(account))throw badRequest(`The mailbox for step ${i+1} is missing, inactive, or not allowed to send.`);
    const html=template.mode==='code'?template.html:blocksToHtml(template.blocks,template.styles);
    const check=preflight({subject:step.subject||template.subject,html,tokens:{},unsubscribeUrl:`https://example.invalid/u/${sequence._id}`});
    if(!check.ok)throw badRequest(`Email step ${i+1} failed preflight. Fix required issues before activation.`,{issues:check.issues});
    hadEmail=true;waitAfterEmail=0;
  }
  return {plan,emails:emails.length};
}

async function activate(ctx,sequence) {
  await validateForActivation(ctx,{...sequence,status:'paused'});
  const now=nowIso();
  const result=await scoped('sequences',ctx).updateOne({_id:sequence._id,status:sequence.status},{$set:{status:'active',
    executionEnabled:true,executionReviewRequired:false,executionReviewReason:null,executionApprovedAt:now,activatedAt:now,updatedAt:now}});
  if(!result.matchedCount)throw badRequest('Workflow status changed; refresh and try again.');
  let resumed=0,triggered=0;
  const paused=await scoped('sequence_enrollments',ctx).find({sequenceId:sequence._id,status:'paused'},{limit:10000});
  for(const row of paused){
    const runAt=row.nextRunAt||now;
    await scoped('sequence_enrollments',ctx).updateOne({_id:row._id,status:'paused'},{$set:{status:Date.parse(runAt)>Date.now()?'waiting':'queued',resumedAt:now,updatedAt:now}});
    await enqueueAutomationStep({organizationId:ctx.organizationId,sequenceId:sequence._id,enrollmentId:row._id,stepIndex:row.currentStep||0,runAt});resumed++;
  }
  const deferred=await scoped('automation_trigger_events',ctx).find({sequenceId:sequence._id,status:'deferred'},{limit:10000});
  const ids=[];for(const event of deferred){const changed=await scoped('automation_trigger_events',ctx).updateOne({_id:event._id,status:'deferred'},{$set:{status:'pending',updatedAt:now}});if(changed.matchedCount)ids.push(event._id);}
  try{await publishAutomationTriggerEvents(ids);triggered=ids.length;}catch(error){console.warn('[automation] activation saved; trigger publish will be retried by scheduler sweep.',String(error?.code||'QUEUE_UNAVAILABLE'));}
  return {ok:true,status:'active',resumed,triggerEvents:triggered};
}

async function pause(ctx,sequence,status='paused') {
  const now=nowIso();
  await scoped('sequences',ctx).updateOne({_id:sequence._id},{$set:{status,executionEnabled:false,pausedAt:now,updatedAt:now}});
  if(status==='paused')await scoped('sequence_enrollments',ctx).updateMany({sequenceId:sequence._id,status:{$in:['queued','waiting','running']}},{$set:{status:'paused',pausedAt:now}});
}

export default async function sequenceRoutes(app) {
  app.get('/sequences', async req => {
    const rows=await scoped('sequences',req.ctx).find({deleted:{$ne:true}},{sort:{createdAt:-1}});
    return rows.map(s=>({...s,stepCount:(s.steps||[]).length}));
  });

  app.post('/sequences', async req => {
    assertPermission(req.ctx,PERMISSIONS.CAMPAIGNS_WRITE);
    const input=sequenceSchema.parse(req.body);
    if(input.status==='active')throw badRequest('Save the workflow first, then explicitly activate it after reviewing the send settings.');
    return scoped('sequences',req.ctx).create({_id:newId(),...input,trigger:input.trigger||'manual',status:input.status||'draft',executionEnabled:false});
  });

  app.patch('/sequences/:id', async req => {
    assertPermission(req.ctx,PERMISSIONS.CAMPAIGNS_WRITE);
    const seq=await scoped('sequences',req.ctx).findOne({_id:req.params.id,deleted:{$ne:true}});
    if(!seq)throw notFound('Automation not found');
    const set={};
    if(req.body.name!==undefined){const name=String(req.body.name).trim();if(name.length<2)throw badRequest('Name must be at least 2 characters');set.name=name;}
    if(req.body.description!==undefined)set.description=String(req.body.description).slice(0,280);
    for(const key of ['trigger','listId','triggerTag','formId','accountId'])if(req.body[key]!==undefined)set[key]=req.body[key];
    if(Array.isArray(req.body.steps)){if(!req.body.steps.length)throw badRequest('At least one step is required');set.steps=sequenceSchema.parse({...seq,steps:req.body.steps}).steps;}
    const status=req.body.status;
    if(status!==undefined&&!['active','paused','draft'].includes(status))throw badRequest('Invalid status');
    if(seq.status==='active'&&seq.executionEnabled===true&&status==='active'&&['trigger','listId','triggerTag','formId','accountId','steps'].some(k=>req.body[k]!==undefined))
      throw badRequest('Pause the automation before editing its trigger, sender or steps.');
    if(status==='active'&&(seq.status!=='active'||seq.executionEnabled!==true)){
      assertPermission(req.ctx,PERMISSIONS.CAMPAIGNS_SEND);
      if(req.body.confirmActivation!==true)throw badRequest('Review the workflow and confirm activation before it can send real emails.');
      const candidate={...seq,...set,status:'paused'};
      await validateForActivation(req.ctx,candidate);
      const result=await scoped('sequences',req.ctx).updateOne({_id:seq._id,status:seq.status},{$set:set});
      if(!result.matchedCount)throw badRequest('Workflow status changed; refresh and try again.');
      const latest=await scoped('sequences',req.ctx).findOne({_id:seq._id});
      return activate(req.ctx,latest);
    }
    if(status==='paused'||status==='draft'){
      await pause(req.ctx,seq,status);
      Object.assign(set,{status,executionEnabled:false});
    }
    if(status===undefined&&seq.status==='active'&&Object.keys(set).length&&['trigger','listId','triggerTag','formId','accountId','steps'].some(k=>k in set))
      throw badRequest('Pause the automation before editing its trigger, sender or steps.');
    if(Object.keys(set).length||status==='paused'||status==='draft')await scoped('sequences',req.ctx).updateOne({_id:seq._id},{$set:{...set,updatedAt:nowIso()}});
    return {ok:true,status:status||seq.status};
  });

  app.delete('/sequences/:id', async req => {
    assertPermission(req.ctx,PERMISSIONS.CAMPAIGNS_WRITE);
    const seq=await scoped('sequences',req.ctx).findOne({_id:req.params.id,deleted:{$ne:true}});
    if(!seq)throw notFound('Automation not found');
    const now=nowIso();await pause(req.ctx,seq,'paused');
    await scoped('sequences',req.ctx).updateOne({_id:seq._id},{$set:{deleted:true,status:'deleted',executionEnabled:false,deletedAt:now}});
    await scoped('sequence_enrollments',req.ctx).updateMany({sequenceId:seq._id,status:{$nin:['completed','stopped','suppressed','needs_review']}},{$set:{status:'cancelled',completedAt:now}});
    await scoped('automation_trigger_events',req.ctx).updateMany({sequenceId:seq._id,status:{$in:['pending','deferred']}},{$set:{status:'cancelled',updatedAt:now}});
    return {ok:true};
  });

  app.get('/sequences/:id', async req => {
    const seq=await scoped('sequences',req.ctx).findOne({_id:req.params.id,deleted:{$ne:true}});
    if(!seq)throw notFound('Automation not found');
    const enrollments=await scoped('sequence_enrollments',req.ctx).find({sequenceId:seq._id},{limit:10000});
    const counts=enrollments.reduce((a,e)=>{a[e.status]=(a[e.status]||0)+1;return a;},{});
    return {...seq,stepCount:(seq.steps||[]).length,enrollmentCounts:counts};
  });

  app.get('/sequences/:id/enrollments', async req => {
    const seq=await scoped('sequences',req.ctx).findOne({_id:req.params.id,deleted:{$ne:true}});if(!seq)throw notFound('Automation not found');
    const rows=await scoped('sequence_enrollments',req.ctx).find({sequenceId:seq._id},{sort:{updatedAt:-1},limit:100});
    return Promise.all(rows.map(async row=>{const contact=await scoped('contacts',req.ctx).findOne({_id:row.contactId});
      return {...row,contactEmail:contact?.email||row.contactEmail||null,contactName:[contact?.firstName,contact?.lastName].filter(Boolean).join(' ')||null};}));
  });

  app.post('/sequences/:id/duplicate', async req => {
    assertPermission(req.ctx,PERMISSIONS.CAMPAIGNS_WRITE);
    const seq=await scoped('sequences',req.ctx).findOne({_id:req.params.id,deleted:{$ne:true}});if(!seq)throw notFound('Automation not found');
    const {_id,createdAt,updatedAt,executionEnabled,executionApprovedAt,activatedAt,legacyPausedAt,executionReviewRequired,executionReviewReason,...rest}=seq;
    return scoped('sequences',req.ctx).create({_id:newId(),...rest,name:`${seq.name} copy`,status:'paused',executionEnabled:false,createdAt:nowIso()});
  });

  app.post('/sequences/:id/enroll', async req => {
    assertPermission(req.ctx,PERMISSIONS.CAMPAIGNS_SEND);
    const seq=await scoped('sequences',req.ctx).findOne({_id:req.params.id,deleted:{$ne:true}});
    if(!seq)throw notFound('Automation not found');
    if(seq.status!=='active'||seq.executionEnabled!==true)throw badRequest('Activate this automation before enrolling contacts.');
    if((seq.trigger||'manual')!=='manual')throw badRequest('This automation starts from its configured trigger, not manual enrollment.');
    const ids=Array.isArray(req.body?.contactIds)?[...new Set(req.body.contactIds.filter(x=>typeof x==='string'))]:[];
    if(!ids.length||ids.length>500)throw badRequest('Select between 1 and 500 contacts.');
    const contacts=await scoped('contacts',req.ctx).find({_id:{$in:ids},deleted:{$ne:true}});
    let queued=0;for(const contact of contacts){const r=await recordAutomationTriggerForSequence({organizationId:req.ctx.organizationId,sequenceId:seq._id,
      contactId:contact._id,source:'manual',details:{requestedBy:req.ctx.user.id}});if(r.queued)queued++;}
    return {ok:true,accepted:contacts.length,queued,skipped:ids.length-contacts.length,oncePerContact:true};
  });

  app.post('/sequences/:id/trigger', async req => {
    assertPermission(req.ctx,PERMISSIONS.CAMPAIGNS_SEND);
    const seq=await scoped('sequences',req.ctx).findOne({_id:req.params.id,deleted:{$ne:true}});if(!seq)throw notFound('Automation not found');
    if(seq.status!=='active'||seq.executionEnabled!==true)throw badRequest('Activate this automation before sending API trigger events.');
    if(seq.trigger!=='api')throw badRequest('This automation is not configured for API triggers.');
    const contact=await scoped('contacts',req.ctx).findOne({_id:req.body?.contactId,deleted:{$ne:true}});if(!contact)throw badRequest('Choose a contact in this workspace.');
    const result=await recordAutomationTriggerForSequence({organizationId:req.ctx.organizationId,sequenceId:seq._id,contactId:contact._id,
      source:'api',details:{requestedBy:req.ctx.user.id}});
    return {ok:true,accepted:result.queued,oncePerContact:true};
  });

  app.post('/sequences/:id/enrollments/:enrollmentId/resume', async req => {
    assertPermission(req.ctx,PERMISSIONS.CAMPAIGNS_SEND);
    const seq=await scoped('sequences',req.ctx).findOne({_id:req.params.id,deleted:{$ne:true}});if(!seq)throw notFound('Automation not found');
    const enrollment=await scoped('sequence_enrollments',req.ctx).findOne({_id:req.params.enrollmentId,sequenceId:seq._id});if(!enrollment)throw notFound('Enrollment not found');
    if(seq.status!=='active'||seq.executionEnabled!==true)throw badRequest('Activate the workflow before resuming this contact.');
    if(enrollment.status!=='needs_review'||enrollment.reviewReason==='provider_outcome_unknown')throw badRequest('This enrollment cannot be safely auto-resumed. Review the provider result first.');
    const index=enrollment.currentStep||0,runId=automationStepRunIdFor(enrollment._id,index);
    await scoped('sequence_step_runs',req.ctx).updateOne({_id:runId,status:'blocked'},{$set:{status:'queued',reason:null,updatedAt:nowIso()}});
    const at=nowIso();await scoped('sequence_enrollments',req.ctx).updateOne({_id:enrollment._id},{$set:{status:'queued',reviewReason:null,lastErrorCode:null,nextRunAt:at,updatedAt:at}});
    await enqueueAutomationStep({organizationId:req.ctx.organizationId,sequenceId:seq._id,enrollmentId:enrollment._id,stepIndex:index,runAt:at});
    return {ok:true,resumed:true};
  });

  app.post('/sequences/:id/enrollments/:enrollmentId/resolve', async req => {
    assertPermission(req.ctx,PERMISSIONS.CAMPAIGNS_SEND);
    const seq=await scoped('sequences',req.ctx).findOne({_id:req.params.id,deleted:{$ne:true}});if(!seq)throw notFound('Automation not found');
    const enrollment=await scoped('sequence_enrollments',req.ctx).findOne({_id:req.params.enrollmentId,sequenceId:seq._id});if(!enrollment)throw notFound('Enrollment not found');
    const index=enrollment.currentStep||0,runId=automationStepRunIdFor(enrollment._id,index);
    const run=await scoped('sequence_step_runs',req.ctx).findOne({_id:runId,status:'delivery_unknown'});if(!run)throw badRequest('There is no ambiguous email step to resolve.');
    if(req.body?.confirm!==true)throw badRequest('Confirm that you checked the provider delivery status.');
    const activeFlow=seq.status==='active'&&seq.executionEnabled===true;
    const steps=Array.isArray(enrollment.stepsSnapshot)?enrollment.stepsSnapshot:seq.steps;
    if(req.body.action==='assume_sent'){
      const at=nowIso(),next=index+1;
      await scoped('sequence_step_runs',req.ctx).updateOne({_id:runId,status:'delivery_unknown'},{$set:{status:'sent',manualResolution:'assumed_sent',resolvedAt:at,nextStepIndex:next,nextRunAt:at}});
      if(next>=steps.length){await scoped('sequence_enrollments',req.ctx).updateOne({_id:enrollment._id},{$set:{status:'completed',currentStep:next,completedAt:at,reviewReason:null}});return {ok:true,status:'completed'};}
      const status=activeFlow?'queued':'paused';
      await scoped('sequence_enrollments',req.ctx).updateOne({_id:enrollment._id},{$set:{status,currentStep:next,nextRunAt:at,reviewReason:null}});
      if(activeFlow)await enqueueAutomationStep({organizationId:req.ctx.organizationId,sequenceId:seq._id,enrollmentId:enrollment._id,stepIndex:next,runAt:at});
      return {ok:true,status,nextStep:next};
    }
    if(req.body.action==='retry_confirmed_not_sent'){
      if(req.body.confirmNoDelivery!==true)throw badRequest('Confirm that the provider shows this email was not accepted; retrying may otherwise duplicate it.');
      const at=nowIso();await scoped('sequence_step_runs',req.ctx).updateOne({_id:runId,status:'delivery_unknown'},{$set:{status:'queued',reason:null,manualResolution:'confirmed_not_sent',resolvedAt:at}});
      const status=activeFlow?'queued':'paused';
      await scoped('sequence_enrollments',req.ctx).updateOne({_id:enrollment._id},{$set:{status,reviewReason:null,nextRunAt:at}});
      if(activeFlow)await enqueueAutomationStep({organizationId:req.ctx.organizationId,sequenceId:seq._id,enrollmentId:enrollment._id,stepIndex:index,runAt:at});
      return {ok:true,status,step:index};
    }
    throw badRequest('Choose assume_sent or retry_confirmed_not_sent.');
  });
}
