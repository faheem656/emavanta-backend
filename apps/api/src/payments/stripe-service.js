import Stripe from 'stripe';
import { dbInfo, nativeDatabase, withMongoTransaction } from '../../../../packages/database/store.js';
import { PLANS } from '../../../../packages/entitlements/definitions.js';
import { AppError, badRequest, conflict, notFound } from '../../../../packages/shared/errors.js';
import { addMonthsClamped } from './crypto-service.js';

// Payment Element / CardElement uses Stripe-hosted fields: raw card numbers and CVC
// never enter this API. Opt-in only; independent deployment review remains required.
let cachedKey, cachedClient, testClient;
export function setStripeClientForTests(client) { if (process.env.NODE_ENV !== 'test') throw new Error('Tests only'); testClient=client; }
function stripeClient() {
  if (process.env.NODE_ENV === 'test' && testClient) return testClient;
  const key=String(process.env.STRIPE_SECRET_KEY||'').trim();
  if (key!==cachedKey) { cachedClient=new Stripe(key,{timeout:10000,maxNetworkRetries:2}); cachedKey=key; }
  return cachedClient;
}
const unavailable=()=>new AppError(424,'STRIPE_UNAVAILABLE','Card payments are unavailable right now.');
export async function stripeReadiness() {
  const key=String(process.env.STRIPE_SECRET_KEY||'').trim(), pub=String(process.env.STRIPE_PUBLISHABLE_KEY||'').trim(), db=dbInfo();
  const live=/^sk_live_[a-zA-Z0-9]+$/.test(key) && /^pk_live_[a-zA-Z0-9]+$/.test(pub);
  const test=/^sk_test_[a-zA-Z0-9]+$/.test(key) && /^pk_test_[a-zA-Z0-9]+$/.test(pub);
  const jwt=String(process.env.JWT_SECRET||''), webhook=String(process.env.STRIPE_WEBHOOK_SECRET||'').trim();
  if(process.env.STRIPE_PAYMENTS_ENABLED!=='true'||!/^whsec_[a-zA-Z0-9]+$/.test(webhook)||(!live&&!test)||(test && process.env.NODE_ENV!=='test' && !(process.env.NODE_ENV!=='production' && process.env.STRIPE_ALLOW_TEST_KEYS==='true'))||jwt.length<32||/demo-jwt-secret|change[-_ ]?me|replace[-_ ]?me/i.test(jwt)||db.driver!=='mongo'||!db.connected)return {available:false};
  try {const hello=await nativeDatabase().admin().command({hello:1});if(!hello.setName && hello.msg!=='isdbgrid')return {available:false};}
  catch{return {available:false};}
  return {available:true,publishableKey:pub,testMode:!live};
}
async function enabled(){const r=await stripeReadiness();if(!r.available)throw unavailable();return r;}

export async function pendingStripe(organizationId){
  const db=nativeDatabase(), lock=await db.collection('payment_method_locks').findOne({_id:organizationId,method:'stripe'});
  if(!lock)return null;
  const order=await db.collection('payment_sessions').findOne({_id:lock.orderId,organizationId});
  return order ? {orderId:order._id,plan:order.plan,amount:order.amount,status:order.status} : null;
}

export async function prepareStripe({organizationId,orderId}) {
  const ready=await enabled(), db=nativeDatabase();
  await withMongoTransaction(async(database,session)=>{
    const orders=database.collection('payment_sessions'),locks=database.collection('payment_method_locks');
    const row=await orders.findOne({_id:orderId,organizationId},{session});
    if(!row)throw notFound('Order not found.');
    if(row.status==='stripe_pending')return;
    if(row.status!=='pending'||row.cryptoNonce||row.kind!=='plan'||!PLANS[row.plan]||row.plan==='free'||!Number.isSafeInteger(row.amount)||row.amount<=0||Date.parse(row.expiresAt)<=Date.now())throw badRequest('This order cannot use card payment. Start a new plan order.');
    const org=await database.collection('organizations').findOne({_id:organizationId},{session});if(!org)throw notFound('Workspace not found.');
    const cryptoOrder=await orders.findOne({organizationId,$or:[{status:'crypto_submitted'},{status:'pending',cryptoNonce:{$exists:true},expiresAt:{$gt:new Date().toISOString()}}]},{session});
    if(cryptoOrder)throw conflict('A crypto payment is already in progress. Resolve it before using a card.');
    const lock=await locks.findOne({_id:organizationId},{session});
    if(lock && (lock.orderId!==orderId || lock.method!=='stripe'))throw conflict('Another payment is already in progress. Resolve it before paying again.');
    if(!lock)await locks.insertOne({_id:organizationId,orderId,method:'stripe',createdAt:new Date().toISOString()},{session});
    const changed=await orders.updateOne({_id:orderId,organizationId,status:'pending',cryptoNonce:{$exists:false}},{$set:{status:'stripe_pending',stripeStartedAt:new Date().toISOString(),stripeExpectedPlan:org.plan||'free',stripeExpectedExpiry:org.planExpiresAt||null,stripeExpectedSource:org.planChangeSource||null}},{session});
    if(!changed.matchedCount)throw conflict('Order changed. Refresh and try again.');
  }).catch(e=>{if(e.code===11000)throw conflict('A card payment is already in progress. Resume it from billing.');throw e;});
  const order=await db.collection('payment_sessions').findOne({_id:orderId,organizationId});
  let intent;
  try {
    if(order.stripeIntentId)intent=await stripeClient().paymentIntents.retrieve(order.stripeIntentId);
    else {
      // Stripe idempotency keys are retained for at least 24h. Never create after
      // that retention window if the original result was lost: manual recovery.
      if(Date.now()-Date.parse(order.stripeStartedAt)>23*3600e3)throw new Error('RECOVERY_WINDOW_EXPIRED');
      intent=await stripeClient().paymentIntents.create({amount:order.amount*100,currency:'usd',payment_method_types:['card'],metadata:{orderId,organizationId},description:order.description||`${order.plan} plan`},{idempotencyKey:`order-${orderId}`});
      await db.collection('payment_sessions').updateOne({_id:orderId,organizationId,status:'stripe_pending',stripeIntentId:{$exists:false}},{$set:{stripeIntentId:intent.id}});
    }
  }catch(e){if(e.message==='RECOVERY_WINDOW_EXPIRED')throw conflict('This payment needs manual review. Contact support; do not pay again.');throw new AppError(424,'STRIPE_CONNECTION','Could not reach the card provider. Resume the existing payment; do not create a new one.');}
  if(intent.metadata?.orderId!==orderId||intent.metadata?.organizationId!==organizationId||intent.amount!==order.amount*100||intent.currency!=='usd'||intent.livemode!==!ready.testMode)throw conflict('Payment details do not match. Contact support; do not pay again.');
  if(intent.status==='succeeded')return reconcileStripe({organizationId,orderId});
  if(intent.status==='canceled')throw conflict('This card payment was canceled. Contact support before paying again.');
  return {status:intent.status,clientSecret:intent.client_secret,publishableKey:ready.publishableKey,testMode:ready.testMode,orderId};
}

export async function reconcileStripe({organizationId,orderId}) {
  await enabled();const db=nativeDatabase(), order=await db.collection('payment_sessions').findOne({_id:orderId,organizationId});
  if(!order)throw notFound('Order not found.');
  if(order.status==='paid'&&order.stripeIntentId)return {status:'paid',plan:order.plan,invoiceId:order.invoiceId};
  if(order.status==='stripe_review')return {status:'review',message:'Payment received but needs manual review. Do not pay again.'};
  if(order.status!=='stripe_pending'||!order.stripeIntentId)return {status:'pending',message:'Payment is not yet confirmed. Do not pay again.'};
  let pi;try{pi=await stripeClient().paymentIntents.retrieve(order.stripeIntentId);}catch{throw new AppError(424,'STRIPE_CONNECTION','Could not verify card payment. Do not pay again; retry status or contact support.');}
  if(pi.status!=='succeeded')return {status:'pending',providerStatus:pi.status};
  const live=String(process.env.STRIPE_SECRET_KEY||'').startsWith('sk_live_');
  if(pi.id!==order.stripeIntentId||pi.metadata?.orderId!==orderId||pi.metadata?.organizationId!==organizationId||pi.amount!==order.amount*100||pi.amount_received!==order.amount*100||pi.currency!=='usd'||pi.livemode!==live)throw conflict('Card payment details require manual review. Do not pay again.');
  const now=new Date(), invoiceId=`stripe-${pi.id}`;
  return withMongoTransaction(async(database,session)=>{
    const orders=database.collection('payment_sessions'), orgs=database.collection('organizations');
    const row=await orders.findOne({_id:orderId,organizationId},{session});
    if(row?.status==='paid')return {status:'paid',plan:row.plan,invoiceId:row.invoiceId};
    if(!row||row.status!=='stripe_pending'||row.stripeIntentId!==pi.id)throw conflict('Payment needs manual review. Do not pay again.');
    const org=await orgs.findOne({_id:organizationId},{session});
    if(!org||(org.plan||'free')!==row.stripeExpectedPlan||(org.planExpiresAt||null)!==row.stripeExpectedExpiry||(org.planChangeSource||null)!==row.stripeExpectedSource){
      await orders.updateOne({_id:orderId,status:'stripe_pending'},{$set:{status:'stripe_review',stripeReviewReason:'workspace plan changed',stripePaidAt:now.toISOString()}},{session});
      return {status:'review',message:'Payment received but needs manual review. Do not pay again.'};
    }
    const previous=org.plan===row.plan && ['crypto','stripe'].includes(org.planChangeSource) ? Date.parse(org.planExpiresAt) : 0;
    const end=addMonthsClamped(new Date(Math.max(now.getTime(),previous||0)),row.interval==='year'?12:1);
    await database.collection('invoices').insertOne({_id:invoiceId,organizationId,number:`CARD-${pi.id.slice(-12).toUpperCase()}`,amount:row.amount,currency:'usd',description:`${row.plan} plan`,status:'paid',method:'Stripe card',chargeId:pi.id,date:now.toISOString().slice(0,10),paidAt:now.toISOString(),createdAt:now.toISOString()},{session});
    await orgs.updateOne({_id:organizationId},{$set:{plan:row.plan,planChangeSource:'stripe',planExpiresAt:end.toISOString(),planStartedAt:(org.plan===row.plan && ['crypto','stripe'].includes(org.planChangeSource) && Date.parse(org.planExpiresAt)>now.getTime() ? (org.planStartedAt || null) : now.toISOString()),planInterval:row.interval,lastPaymentAt:now.toISOString()}},{session});
    await orders.updateOne({_id:orderId,status:'stripe_pending'},{$set:{status:'paid',paidAt:now.toISOString(),invoiceId}},{session});
    await database.collection('payment_method_locks').deleteOne({_id:organizationId,orderId,method:'stripe'},{session});
    return {status:'paid',plan:row.plan,invoiceId,expiresAt:end.toISOString()};
  });
}
// Verify the signature over the exact request bytes. The event is only a trigger;
// reconciliation retrieves the PaymentIntent independently from Stripe.
export async function handleStripeWebhook(rawBody, signature) {
  await enabled();
  if(typeof rawBody!=='string' || !signature)throw badRequest('Invalid webhook signature.');
  let event;try{event=stripeClient().webhooks.constructEvent(rawBody,signature,process.env.STRIPE_WEBHOOK_SECRET);}catch{throw badRequest('Invalid webhook signature.');}
  if(event.type!=='payment_intent.succeeded')return {received:true};
  const pi=event.data?.object, orderId=pi?.metadata?.orderId, organizationId=pi?.metadata?.organizationId;
  if(!orderId||!organizationId||!/^pi_[a-zA-Z0-9_]+$/.test(String(pi.id||'')))return {received:true};
  const db=nativeDatabase(),order=await db.collection('payment_sessions').findOne({_id:orderId,organizationId});
  if(!order)return {received:true};
  if(order.status==='paid')return {received:true};
  if(order.status!=='stripe_pending')return {received:true};
  if(!order.stripeIntentId){
    // Recover the case where Stripe returned success but our process crashed
    // before persisting the intent ID. The signature authenticates metadata.
    if(pi.amount!==order.amount*100||pi.currency!=='usd'||pi.livemode!==String(process.env.STRIPE_SECRET_KEY||'').startsWith('sk_live_'))return {received:true};
    await db.collection('payment_sessions').updateOne({_id:orderId,organizationId,status:'stripe_pending',stripeIntentId:{$exists:false}},{$set:{stripeIntentId:pi.id}});
  }
  const status=await reconcileStripe({organizationId,orderId});
  return {received:true,status:status.status};
}

// Only release the organization lock after Stripe confirms the intent is canceled.
// If the result is uncertain, keep the lock and tell the user not to pay again.
export async function cancelStripe({organizationId,orderId}) {
  await enabled();const db=nativeDatabase();let row=await db.collection('payment_sessions').findOne({_id:orderId,organizationId});
  if(!row)throw notFound('Order not found.');
  if(row.status==='paid'||row.status==='stripe_review')throw conflict('Payment may already be complete. Contact support; do not pay again.');
  if(row.status==='stripe_canceled')return {status:'canceled'};
  if(row.status!=='stripe_pending')throw conflict('This card order cannot be canceled.');
  if(!row.stripeIntentId){await prepareStripe({organizationId,orderId});row=await db.collection('payment_sessions').findOne({_id:orderId,organizationId});}
  let pi;try {pi=await stripeClient().paymentIntents.retrieve(row.stripeIntentId);if(pi.status!=='canceled')pi=await stripeClient().paymentIntents.cancel(row.stripeIntentId);}
  catch {throw new AppError(424,'STRIPE_CANCEL_UNCERTAIN','The card provider did not confirm cancellation. Check status or contact support; do not pay again.');}
  if(pi.status!=='canceled'||pi.id!==row.stripeIntentId||pi.metadata?.orderId!==orderId||pi.metadata?.organizationId!==organizationId)throw conflict('Cancellation could not be verified. Do not pay again.');
  return withMongoTransaction(async(database,session)=>{
    const changed=await database.collection('payment_sessions').updateOne({_id:orderId,organizationId,status:'stripe_pending',stripeIntentId:pi.id},{$set:{status:'stripe_canceled',canceledAt:new Date().toISOString()}},{session});
    if(!changed.matchedCount)throw conflict('Payment status changed. Check status before paying again.');
    await database.collection('payment_method_locks').deleteOne({_id:organizationId,orderId,method:'stripe'},{session});
    return {status:'canceled'};
  });
}

export async function sweepStripe(){
  if(!(await stripeReadiness()).available)return;
  const rows=await nativeDatabase().collection('payment_sessions').find({status:'stripe_pending',stripeIntentId:{$exists:true}}).sort({stripeLastCheckedAt:1,stripeStartedAt:1}).limit(25).toArray();
  for(const row of rows){await nativeDatabase().collection('payment_sessions').updateOne({_id:row._id,status:'stripe_pending'},{$set:{stripeLastCheckedAt:new Date().toISOString()}});try{await reconcileStripe({organizationId:row.organizationId,orderId:row._id});}catch{/* Retain for later retry and operator investigation. */}}
}
