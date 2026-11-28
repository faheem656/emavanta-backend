import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { nativeDatabase, dbInfo, withMongoTransaction } from '../../../../packages/database/store.js';
import { PLANS, ADDONS } from '../../../../packages/entitlements/definitions.js';
import { validAddress, bscClient, checkBsc, BSC_USDT } from './bsc.js';
import { paymentProofMessage, verifyPaymentClaim } from './payment-proof.js';
import { sendAuthMail, smtpConfigured, smtpTransport } from '../mail-auth.js';
import { AppError, badRequest, conflict, notFound } from '../../../../packages/shared/errors.js';

const unavailable=()=>new AppError(424,'CRYPTO_UNAVAILABLE','Crypto payments are unavailable. Do not send funds.');
const getRpc=()=>bscClient(String(process.env.BSC_RPC_URL || '').trim());
const ownerEmail=()=>String(process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
const wallet=()=>String(process.env.BSC_USDT_RECEIVING_ADDRESS || '').trim().toLowerCase();
// Detailed checks are for the MFA-gated owner and local diagnostics only. No
// address, RPC URL, email, credentials or raw network errors are returned.
export async function cryptoSetupDiagnostics() {
  const info=dbInfo(), jwt=String(process.env.JWT_SECRET||'');
  let smtpValid=false;
  try {const transport=smtpTransport();smtpValid=true;transport.close();} catch { /* invalid configuration, no network attempted */ }
  const checks={
    enabled:process.env.CRYPTO_PAYMENTS_ENABLED==='true',
    database:info.driver==='mongo'&&info.connected,
    transactions:null,
    ownerConfigured:!!ownerEmail(), ownerVerifiedMfa:null,
    jwtSecure:jwt.length>=32&&!/demo-jwt-secret|change[-_ ]?me|replace[-_ ]?me/i.test(jwt),
    smtpConfigured:smtpConfigured(), smtpSettingsValid:smtpValid,
    receivingAddress:validAddress(wallet()),rpcConfigured:!!String(process.env.BSC_RPC_URL||'').trim(),rpcVerified:null
  };
  if(checks.database){
    try {const db=nativeDatabase(),hello=await db.admin().command({hello:1});checks.transactions=Boolean(hello.setName||hello.msg==='isdbgrid');
      checks.ownerVerifiedMfa=checks.ownerConfigured?Boolean(await db.collection('users').findOne({email:ownerEmail(),emailVerified:true,mfaEnabled:true})):false;
    } catch {checks.transactions=false;checks.ownerVerifiedMfa=false;}
  }
  if(checks.enabled&&checks.rpcConfigured){try{await checkBsc(getRpc());checks.rpcVerified=true;}catch{checks.rpcVerified=false;}}
  return {available:Object.values(checks).every(value=>value===true),checks};
}
export async function cryptoReadiness() {
  const status=await cryptoSetupDiagnostics();
  return status.available?{available:true,address:wallet(),network:'BNB Smart Chain',token:BSC_USDT,confirmations:64}:{available:false};
}

const enabled=async()=>{const status=await cryptoReadiness();if(!status.available)throw unavailable();return status;};

export async function prepareCrypto({organizationId, sessionId, payerWallet, termsAccepted}) {
  await enabled();
  if(termsAccepted!==true)throw badRequest('Accept the payment terms before continuing.');
  if(!validAddress(payerWallet))throw badRequest('Connect a valid wallet.');
  const db=nativeDatabase();
  const addr=payerWallet.toLowerCase(), nonce=randomBytes(32).toString('hex'), quoteExpiry=new Date(Date.now()+24*3600e3).toISOString();
  let current;
  try {
    current=await withMongoTransaction(async(database,session)=>{
      const col=database.collection('payment_sessions'), locks=database.collection('payment_method_locks');
      const org=await database.collection('organizations').findOne({_id:organizationId},{session});
      if(!org)throw notFound('Workspace not found.');
      const row=await col.findOne({_id:sessionId,organizationId},{session});
      const validPlan=row?.kind==='plan'&&PLANS[row.plan]&&row.plan!=='free';
      const validAddon=row?.kind==='addon'&&ADDONS[row.code]&&Number.isSafeInteger(row.quantity)&&row.quantity>=1&&row.quantity<=20&&row.amount===ADDONS[row.code].price*row.quantity;
      if(!row||(!validPlan&&!validAddon)||!Number.isSafeInteger(row.amount)||row.amount<=0)throw badRequest('This order cannot use crypto.');
      if(row.status!=='pending'||Date.parse(row.expiresAt)<=Date.now())throw badRequest('This order has expired or has already been submitted. Contact support if funds were sent.');
      const lock=await locks.findOne({_id:organizationId},{session});
      if(lock&&(lock.orderId!==sessionId||lock.method!=='crypto'))throw conflict('Another payment is already in progress. Resolve it before paying again.');
      if(row.cryptoNonce&&row.cryptoWallet!==addr)throw conflict('This order is already bound to another wallet.');
      if(row.cryptoFlowVersion===2 && row.cryptoTransferStarted===true)throw conflict('A transfer was already requested. Do not send another payment; contact support.');
      if(!lock)await locks.insertOne({_id:organizationId,orderId:sessionId,method:'crypto',createdAt:new Date().toISOString()},{session});
      if(row.cryptoNonce)return row;
      const changed=await col.updateOne({_id:sessionId,organizationId,status:'pending',cryptoNonce:{$exists:false}},{$set:{
        cryptoNonce:nonce,cryptoFlowVersion:2,cryptoTransferStarted:false,cryptoWallet:addr,cryptoRecipient:wallet(),cryptoExpectedPlan:org.plan||'free',cryptoExpectedExpiry:org.planExpiresAt||null,cryptoExpectedSource:org.planChangeSource||null,cryptoTermsAcceptedAt:new Date().toISOString(),expiresAt:quoteExpiry}},{session});
      if(!changed.matchedCount)throw conflict('Order changed. Refresh and try again.');
      return {...row,cryptoNonce:nonce,cryptoWallet:addr,cryptoRecipient:wallet(),expiresAt:quoteExpiry};
    });
  }catch(e){if(e.code===11000)throw conflict('Another payment is already in progress. Resolve it before paying again.');throw e;}
  return {message:paymentProofMessage({orderId:sessionId,organizationId,wallet:addr,nonce:current.cryptoNonce}),
    recipient:current.cryptoRecipient||wallet(),amount:current.amount,expiresAt:current.expiresAt,token:BSC_USDT,network:'BNB Smart Chain',kind:current.kind,plan:current.plan,code:current.code,quantity:current.quantity,interval:current.interval};
}

// Cancellation is safe only before a v2 order has requested a wallet transfer.
// Older prepared orders lack that proof and must be reconciled by an operator.
export async function cancelCrypto({organizationId,sessionId}) {
 return withMongoTransaction(async(db,session)=>{
  const orders=db.collection('payment_sessions'),locks=db.collection('payment_method_locks');
  const row=await orders.findOne({_id:sessionId,organizationId},{session});
  if(!row)throw notFound('Order not found.');
  if(row.status==='canceled')return {status:'canceled',alreadyCanceled:true};
  if(row.status!=='pending')throw conflict('This order cannot be canceled; contact support if a transfer was sent.');
  if(row.cryptoNonce && !(row.cryptoFlowVersion===2&&row.cryptoTransferStarted===false))throw conflict('A transfer may have been requested. Contact support; do not pay again.');
  const changed=await orders.updateOne({_id:sessionId,organizationId,status:'pending',...(row.cryptoNonce?{cryptoFlowVersion:2,cryptoTransferStarted:false}:{cryptoNonce:{$exists:false}})},{$set:{status:'canceled',canceledAt:new Date().toISOString()}},{session});
  if(!changed.matchedCount)throw conflict('Order changed. Contact support before sending funds.');
  await locks.deleteOne({_id:organizationId,orderId:sessionId,method:'crypto'},{session});
  return {status:'canceled'};
 });
}
// A customer may request cancellation even when transfer status is uncertain.
// This does not release the lock or reverse funds; an owner must investigate.
export async function requestCryptoCancellation({organizationId,sessionId}) {
 const now=new Date().toISOString();
 const result=await withMongoTransaction(async(db,session)=>{
  const lock=await db.collection('payment_method_locks').findOne({_id:organizationId,orderId:sessionId,method:'crypto'},{session});
  const orders=db.collection('payment_sessions'),row=await orders.findOne({_id:sessionId,organizationId},{session});
  if(!lock||!row||!['pending','crypto_submitted'].includes(row.status))throw conflict('This order is not open for a cancellation request.');
  if(row.cancelRequestedAt)return {status:'requested',alreadyRequested:true,requestedAt:row.cancelRequestedAt};
  const changed=await orders.updateOne({_id:sessionId,organizationId,status:row.status,$or:[{cancelRequestedAt:{$exists:false}},{cancelRequestedAt:null}]},{$set:{cancelRequestedAt:now,cancelNotificationStatus:'pending'}},{session});
  if(!changed.matchedCount)throw conflict('Order changed. Refresh and review the payment.');
  if(row.status==='crypto_submitted'){
   const payment=await db.collection('crypto_payments').updateOne({_id:row.cryptoTxHash,orderId:sessionId,organizationId,status:'pending'},{$set:{cancelRequestedAt:now}},{session});
   if(!payment.matchedCount)throw conflict('Payment changed. Refresh and review.');
  }
  return {status:'requested',requestedAt:now};
 });
 if(!result.alreadyRequested){
  void sendAuthMail({to:ownerEmail(),kind:'crypto cancellation request',subject:'Emavanta USDT cancellation request',text:`A customer requested cancellation of USDT order ${sessionId} for workspace ${organizationId}. Check the owner dashboard and reconcile any transfer before closing the lock. A blockchain transfer cannot be reversed by canceling an order.`})
   .then(r=>nativeDatabase().collection('payment_sessions').updateOne({_id:sessionId,organizationId,cancelRequestedAt:now},{$set:{cancelNotificationStatus:r.sent?'sent':'failed'}})).catch(()=>{});
 }
 return result;
}
export async function beginCryptoTransfer({organizationId,sessionId}) {
 await enabled();
 const result=await nativeDatabase().collection('payment_sessions').updateOne({_id:sessionId,organizationId,status:'pending',cryptoFlowVersion:2,cryptoTransferStarted:false,$or:[{cancelRequestedAt:{$exists:false}},{cancelRequestedAt:null}],expiresAt:{$gt:new Date(Date.now()+90000).toISOString()}},{$set:{cryptoTransferStarted:true,cryptoTransferRequestedAt:new Date().toISOString()}});
 if(!result.matchedCount)throw conflict('Order canceled, expired or already used. Do not send another payment.');
 return {ok:true};
}

export async function submitCrypto({organizationId, sessionId, submittedByUserId, txHash, signature}) {
  await enabled();
  if(!/^0x[0-9a-f]{64}$/i.test(String(txHash||''))||!/^0x[0-9a-f]{130}$/i.test(String(signature||'')))throw badRequest('Provide a valid transaction hash and wallet signature.');
  txHash=txHash.toLowerCase();
  const db=nativeDatabase(), order=await db.collection('payment_sessions').findOne({_id:sessionId,organizationId});
  if(!order||!order.cryptoNonce||!order.cryptoWallet)throw badRequest('Connect and sign with the wallet used for this order first.');
  if(order.cryptoFlowVersion===2 && order.cryptoTransferStarted!==true)throw badRequest('Transfer was not started for this order.');
  const existing=await db.collection('crypto_payments').findOne({_id:txHash});
  if(existing){if(existing.orderId===sessionId&&existing.organizationId===organizationId)return {status:existing.status,txHash,duplicate:true};throw conflict('This transaction has already been submitted.');}
  if(order.status!=='pending')throw conflict('This order is no longer awaiting a transaction.');
  const message=paymentProofMessage({orderId:sessionId,organizationId,wallet:order.cryptoWallet,nonce:order.cryptoNonce});
  let recovered;try{recovered=verifyMessage(message,signature).toLowerCase();}catch{throw badRequest('Invalid wallet signature.');}
  if(recovered!==order.cryptoWallet)throw badRequest('The signature does not match this wallet.');
  // Claim only a transaction sent directly by the signing wallet to the canonical
  // USDT contract. Final amount/recipient/confirmations are checked on approval.
  let tx,chain;try{const rpc=getRpc();[tx,chain]=await Promise.all([rpc('eth_getTransactionByHash',[txHash]),rpc('eth_chainId')]);}catch{throw new AppError(424,'RPC_UNAVAILABLE','Unable to check the blockchain right now. Keep your transaction hash and retry.');}
  if(!tx)throw badRequest('Transaction not visible yet. Keep the hash and retry shortly.');
  if(String(chain).toLowerCase()!=='0x38'||String(tx.hash||'').toLowerCase()!==txHash||String(tx.from||'').toLowerCase()!==order.cryptoWallet||String(tx.to||'').toLowerCase()!==BSC_USDT)throw badRequest('This transaction must be a direct USDT transfer from your connected wallet on BNB Smart Chain.');
  const now=new Date().toISOString();
  try {
    await withMongoTransaction(async(database,session)=>{
      const orders=database.collection('payment_sessions');
      const current=await orders.findOne({_id:sessionId,organizationId,status:'pending',cryptoNonce:order.cryptoNonce},{session});
      if(!current)throw conflict('This order was already submitted.');
      const changed=await orders.updateOne({_id:sessionId,organizationId,status:'pending',cryptoNonce:order.cryptoNonce},{$set:{status:'crypto_submitted',cryptoTxHash:txHash,submittedAt:now}},{session});
      if(!changed.matchedCount)throw conflict('This order was already submitted.');
      await database.collection('crypto_payments').insertOne({_id:txHash,orderId:sessionId,organizationId,createdByUserId:current.createdByUserId||null,submittedByUserId:submittedByUserId||null,kind:current.kind||'plan',plan:current.plan,code:current.code||null,quantity:current.quantity||1,interval:current.interval,
        amount:current.amount,recipient:current.cryptoRecipient,wallet:current.cryptoWallet,nonce:current.cryptoNonce,signature,
        notBefore:Math.floor(Date.parse(current.createdAt)/1000)-60,notAfter:Math.floor(Date.parse(current.expiresAt)/1000),
        expectedPlan:current.cryptoExpectedPlan,expectedExpiry:current.cryptoExpectedExpiry||null,expectedSource:current.cryptoExpectedSource||null,status:'pending',notificationStatus:'pending',...(current.cancelRequestedAt?{cancelRequestedAt:current.cancelRequestedAt}:{}),createdAt:now},{session});
    });
  }catch(e){if(e.code===11000)throw conflict('This transaction has already been submitted.');throw e;}
  // The dashboard record survives even if SMTP fails. The owner can retry the alert.
  void notifyOwner(txHash).catch(() => {});
  return {status:'pending',txHash,notificationStatus:'pending'};
}
export async function notifyOwner(txHash) {
  const db=nativeDatabase(), col=db.collection('crypto_payments'), payment=await col.findOne({_id:txHash});
  if(!payment)throw notFound('Payment not found.');
  const [org,payer]=await Promise.all([db.collection('organizations').findOne({_id:payment.organizationId},{projection:{name:1}}), (payment.submittedByUserId||payment.createdByUserId)?db.collection('users').findOne({_id:payment.submittedByUserId||payment.createdByUserId},{projection:{name:1,email:1}}):null]);
  const delivery=await sendAuthMail({to:ownerEmail(),kind:'crypto owner notification',subject:'Emavanta crypto payment awaiting review',
    text:`A USDT payment was submitted for review.\nWorkspace: ${org?.name||'Unknown'} (${payment.organizationId})\nUser: ${payer?.name||'Unknown'} (${payer?.email||'Unknown'}, ${payment.submittedByUserId||payment.createdByUserId||'unknown'})\nOrder: ${payment.kind==='addon' ? `${payment.code} × ${payment.quantity}` : payment.plan}\nAmount: ${payment.amount} USDT\nTransaction: ${payment._id}\nOpen the owner dashboard to verify and review. Do not approve without verifying on chain.`});
  const status=delivery.sent?'sent':'failed';
  await col.updateOne({_id:txHash},{$set:{notificationStatus:status,notificationAttemptedAt:new Date().toISOString()}});
  return {status};
}
export async function reviewCrypto({txHash, ownerId}) {
  await enabled();
  if(!/^0x[0-9a-f]{64}$/i.test(String(txHash||'')))throw badRequest('Invalid transaction hash.');
  txHash=txHash.toLowerCase();const db=nativeDatabase(), payment=await db.collection('crypto_payments').findOne({_id:txHash});
  if(!payment)throw notFound('Payment not found.');if(payment.status==='approved')return {status:'approved',alreadyApproved:true};
  if(payment.cancelRequestedAt)throw conflict('The customer requested cancellation. Review the transfer and resolve the request before approval.');
  if(payment.status!=='pending')throw conflict('Payment is not awaiting review.');
  try {await verifyPaymentClaim(getRpc(),{orderId:payment.orderId,organizationId:payment.organizationId,wallet:payment.wallet,nonce:payment.nonce,
    signature:payment.signature,txHash,recipient:payment.recipient,amountUsd:payment.amount,notBefore:payment.notBefore,notAfter:payment.notAfter});}
  catch {throw badRequest('On-chain verification failed or confirmations are not sufficient. Do not approve; check the transaction and try again later.');}
  const now=new Date();
  return withMongoTransaction(async(database,session)=>{
    const payments=database.collection('crypto_payments'), orders=database.collection('payment_sessions'), orgs=database.collection('organizations');
    const row=await payments.findOne({_id:txHash},{session});
    if(row?.status==='approved')return {status:'approved',alreadyApproved:true};
    if(row?.cancelRequestedAt)throw conflict('The customer requested cancellation. Review the transfer and resolve the request before approval.');
    if(!row||row.status!=='pending')throw conflict('Payment is not awaiting review.');
    const org=await orgs.findOne({_id:row.organizationId},{session});if(!org)throw notFound('Workspace not found.');
    if((org.plan||'free')!==row.expectedPlan || (org.planExpiresAt||null)!==row.expectedExpiry || (org.planChangeSource||null)!==row.expectedSource)throw conflict('The workspace plan changed since checkout. Review manually before proceeding.');
    const isAddon=row.kind==='addon';
    if(isAddon&&(!ADDONS[row.code]||!Number.isSafeInteger(row.quantity)||row.quantity<1||row.quantity>20||row.amount!==ADDONS[row.code].price*row.quantity))throw conflict('Add-on order requires manual review.');
    const previousExpiry=!isAddon&&org.plan===row.plan && ['crypto','stripe'].includes(org.planChangeSource) ? Date.parse(org.planExpiresAt) : 0;
    const end=addMonthsClamped(new Date(Math.max(now.getTime(),previousExpiry||0)),isAddon?1:(row.interval==='year'?12:1));
    const invoiceId=`crypto-${txHash}`;
    const description=isAddon?`${ADDONS[row.code].label} × ${row.quantity} · one month`:`${row.plan} plan`;
    await database.collection('invoices').insertOne({_id:invoiceId,organizationId:row.organizationId,number:`USDT-${txHash.slice(2,12).toUpperCase()}`,
      amount:row.amount,currency:'usd',description,status:'paid',method:'USDT BEP-20',txHash,date:now.toISOString().slice(0,10),paidAt:now.toISOString(),createdAt:now.toISOString()},{session});
    if(isAddon){
      await database.collection('crypto_addon_grants').insertOne({_id:txHash,organizationId:row.organizationId,code:row.code,quantity:row.quantity,status:'active',startsAt:now.toISOString(),expiresAt:end.toISOString()},{session});
      // Verification credit PACKS grant a one-time lifetime balance — they must
      // NOT go through cryptoAddons (that path is monthly/expiring by design).
      const packGrant = ADDONS[row.code]?.grants === 'verifyCredits' ? ADDONS[row.code].amount * row.quantity : 0;
      await orgs.updateOne({_id:row.organizationId}, packGrant
        ? {$inc:{verifyCredits: packGrant},$set:{lastPaymentAt:now.toISOString()}}
        : {$inc:{[`cryptoAddons.${row.code}`]:row.quantity},$set:{lastPaymentAt:now.toISOString()}},{session});
    }else await orgs.updateOne({_id:row.organizationId},{$set:{plan:row.plan,planChangeSource:'crypto',planExpiresAt:end.toISOString(),planStartedAt:(org.plan===row.plan && ['crypto','stripe'].includes(org.planChangeSource) && Date.parse(org.planExpiresAt)>now.getTime() ? (org.planStartedAt || null) : now.toISOString()),planInterval:row.interval,lastPaymentAt:now.toISOString()}},{session});
    const updatedOrder=await orders.updateOne({_id:row.orderId,organizationId:row.organizationId,status:'crypto_submitted'},{$set:{status:'paid',invoiceId,paidAt:now.toISOString()}},{session});
    if(!updatedOrder.matchedCount)throw conflict('Order changed; no payment was applied.');
    await payments.updateOne({_id:txHash,status:'pending'},{$set:{status:'approved',reviewedBy:ownerId,approvedAt:now.toISOString(),invoiceId,expiresAt:end.toISOString()}},{session});
    await database.collection('payment_method_locks').deleteOne({_id:row.organizationId,orderId:row.orderId,method:'crypto'},{session});
    return {status:'approved',kind:isAddon?'addon':'plan',plan:row.plan,code:row.code,quantity:row.quantity,expiresAt:end.toISOString(),invoiceId};
  });
}
// Rejecting a review does not reverse a blockchain transfer or automatically
// release the payment lock. An operator must reconcile funds separately.
export async function rejectCrypto({txHash,ownerId,reason}) {
 if(!/^0x[0-9a-f]{64}$/i.test(String(txHash||'')))throw badRequest('Invalid transaction hash.');
 if(typeof reason!=='string'||reason.trim().length<10||reason.trim().length>500)throw badRequest('Provide a reason of 10–500 characters.');
 txHash=txHash.toLowerCase();const now=new Date().toISOString();
 return withMongoTransaction(async(db,session)=>{
  const payments=db.collection('crypto_payments'),orders=db.collection('payment_sessions');
  const row=await payments.findOne({_id:txHash},{session});if(!row)throw notFound('Payment not found.');
  if(row.status==='rejected')return {status:'rejected',alreadyRejected:true};
  if(row.status!=='pending')throw conflict('Payment is not awaiting review.');
  const updated=await payments.updateOne({_id:txHash,status:'pending'},{$set:{status:'rejected',reviewedBy:ownerId,rejectedAt:now,rejectionReason:reason.trim()}},{session});
  const order=await orders.updateOne({_id:row.orderId,organizationId:row.organizationId,status:'crypto_submitted'},{$set:{status:'crypto_rejected',rejectedAt:now}},{session});
  if(!updated.matchedCount||!order.matchedCount)throw conflict('Payment changed; no action was applied.');
  await db.collection('platform_admin_events').insertOne({_id:`crypto-reject-${txHash}`,actorId:ownerId,targetOrganizationId:row.organizationId,type:'crypto_rejected',reason:reason.trim(),txHash,status:'applied',createdAt:now},{session});
  return {status:'rejected',message:'Review rejected. Funds were not returned; reconcile manually before any further payment.'};
 });
}
// Explicit operator-only recovery of an unsubmitted order. The RPC cannot prove
// that a wallet has not signed or broadcast a transfer; this is a manual risk.
export async function resolveCryptoLock({organizationId,orderId,ownerId,reason,confirmedNoTransfer}) {
 if(confirmedNoTransfer!==true||typeof reason!=='string'||reason.trim().length<20||reason.trim().length>500)throw badRequest('Confirm investigation and provide a 20–500 character reason.');
 const now=new Date().toISOString();
 return withMongoTransaction(async(db,session)=>{
  const lock=await db.collection('payment_method_locks').findOne({_id:organizationId,orderId,method:'crypto'},{session});
  if(!lock)throw conflict('Open crypto lock not found. Refresh and check the order.');
  const order=await db.collection('payment_sessions').findOne({_id:orderId,organizationId},{session});
  if(!order||order.status!=='pending')throw conflict('Only an unsubmitted order can be investigated here.');
  if(await db.collection('crypto_payments').findOne({orderId,organizationId},{session}))throw conflict('A transaction was submitted; handle it as a payment review.');
  const changed=await db.collection('payment_sessions').updateOne({_id:orderId,organizationId,status:'pending'},{$set:{status:'canceled',canceledAt:now,canceledBy:ownerId,cancelReason:'manual_reconciliation'}},{session});
  if(!changed.matchedCount)throw conflict('Order changed. Refresh and review.');
  await db.collection('payment_method_locks').deleteOne({_id:organizationId,orderId,method:'crypto'},{session});
  await db.collection('platform_admin_events').insertOne({_id:`crypto-lock-${orderId}`,actorId:ownerId,targetOrganizationId:organizationId,type:'crypto_lock_manual_cancel',reason:reason.trim(),status:'applied',createdAt:now},{session});
  return {status:'canceled',message:'Order closed after manual review. An on-chain transfer cannot be reversed by this action.'};
 });
}
// Closing a rejected submission is a deliberate manual settlement decision,
// not evidence of a refund. Never apply a plan or release automatically.
export async function resolveRejectedCryptoLock({organizationId,orderId,ownerId,reason,confirmedReconciled}) {
 if(confirmedReconciled!==true||typeof reason!=='string'||reason.trim().length<20||reason.trim().length>500)throw badRequest('Confirm funds reconciliation and provide a 20–500 character reason.');
 const now=new Date().toISOString();
 return withMongoTransaction(async(db,session)=>{
  const locks=db.collection('payment_method_locks'),orders=db.collection('payment_sessions');
  if(!await locks.findOne({_id:organizationId,orderId,method:'crypto'},{session}))throw conflict('Open crypto lock not found.');
  const order=await orders.findOne({_id:orderId,organizationId,status:'crypto_rejected'},{session});
  if(!order||!await db.collection('crypto_payments').findOne({orderId,organizationId,status:'rejected'},{session}))throw conflict('Only a rejected payment can be settled here.');
  const changed=await orders.updateOne({_id:orderId,organizationId,status:'crypto_rejected'},{$set:{reconciledAt:now,reconciledBy:ownerId}},{session});
  if(!changed.matchedCount)throw conflict('Payment changed. Refresh and review.');
  await locks.deleteOne({_id:organizationId,orderId,method:'crypto'},{session});
  await db.collection('platform_admin_events').insertOne({_id:`crypto-reconcile-${orderId}`,actorId:ownerId,targetOrganizationId:organizationId,type:'crypto_rejected_lock_closed',reason:reason.trim(),status:'applied',createdAt:now},{session});
  return {status:'reconciled',message:'Rejected payment marked reconciled and lock closed. No refund or blockchain transfer was made by this action.'};
 });
}
export async function listCrypto(organizationId){
  const query=organizationId?{organizationId}:{};
  const rows=await nativeDatabase().collection('crypto_payments').find(query,{projection:{signature:0,nonce:0}}).sort({createdAt:-1}).limit(100).toArray();
  if (organizationId) return rows.map(r=>({...r,txHash:r._id}));
  // Owner-only review: show the identity captured when the order was created.
  // Legacy orders may not have a creator; never infer or invent one.
  const db=nativeDatabase();
  return Promise.all(rows.map(async r=>{
    const [org,user]=await Promise.all([
      db.collection('organizations').findOne({_id:r.organizationId},{projection:{name:1}}),
      (r.submittedByUserId||r.createdByUserId) ? db.collection('users').findOne({_id:r.submittedByUserId||r.createdByUserId},{projection:{name:1,email:1}}) : null
    ]);
    return {...r,txHash:r._id,workspaceName:org?.name||null,payer:(r.submittedByUserId||r.createdByUserId)?{id:r.submittedByUserId||r.createdByUserId,name:user?.name||null,email:user?.email||null}:null};
  }));
}

export function addMonthsClamped(date,months) {
  const target=new Date(date);const day=target.getUTCDate();target.setUTCDate(1);target.setUTCMonth(target.getUTCMonth()+months);
  const last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();target.setUTCDate(Math.min(day,last));return target;
}
// An add-on term is a one-time month from approval. Expired grants are
// removed once, transactionally; legacy/manual add-ons are never modified.
export async function expireCryptoAddons(organizationId) {
 const now=new Date().toISOString();
 if(!await nativeDatabase().collection('crypto_addon_grants').findOne({organizationId,status:'active',expiresAt:{$lte:now}},{projection:{_id:1}}))return;
 return withMongoTransaction(async(db,session)=>{
  const grants=db.collection('crypto_addon_grants'),orgs=db.collection('organizations');
  const expired=await grants.find({organizationId,status:'active',expiresAt:{$lte:now}},{session}).toArray();
  if(!expired.length)return;
  const org=await orgs.findOne({_id:organizationId},{session});if(!org)throw notFound('Workspace not found.');
  const updated={...(org.cryptoAddons||{})};
  for(const grant of expired){
   if(!ADDONS[grant.code]||!Number.isSafeInteger(grant.quantity)||grant.quantity<1)throw conflict('Add-on grant requires operator review.');
   updated[grant.code]=Math.max(0,(Number(updated[grant.code])||0)-grant.quantity);
  }
  await orgs.updateOne({_id:organizationId},{$set:{cryptoAddons:updated}},{session});
  await grants.updateMany({_id:{$in:expired.map(g=>g._id)},status:'active'},{$set:{status:'expired',expiredAt:now}},{session});
 });
}
// Called from authenticated API requests and before worker delivery. CAS ensures a
// concurrently renewed plan cannot be downgraded by an old expiry observation.
export async function expireCryptoSubscription(organizationId) {
  await expireCryptoAddons(organizationId);
  const orgs=nativeDatabase().collection('organizations');const org=await orgs.findOne({_id:organizationId});
  if(!org||!['crypto','stripe','platform_manual_override'].includes(org.planChangeSource)||!org.planExpiresAt||Date.parse(org.planExpiresAt)>Date.now())return org;
  await orgs.updateOne({_id:organizationId,planChangeSource:org.planChangeSource,planExpiresAt:org.planExpiresAt},
    {$set:{plan:'free',planChangeSource:org.planChangeSource+'_expired',previousPlanStartedAt:org.planStartedAt || null,planStartedAt:new Date().toISOString(),planInterval:null,cryptoExpiredAt:new Date().toISOString()}});
  return orgs.findOne({_id:organizationId});
}
