import { assertPermission, PERMISSIONS } from '../../../../packages/security/rbac.js';
import { isMemoryMode, nativeDatabase } from '../../../../packages/database/store.js';
import { requirePlatformOwner } from '../platform-owner.js';
import { forbidden } from '../../../../packages/shared/errors.js';
import { stripeReadiness, prepareStripe, reconcileStripe, pendingStripe, cancelStripe, handleStripeWebhook } from '../payments/stripe-service.js';
const billing=ctx=>{if(ctx?.apiKeyId)throw forbidden('Use a signed-in billing account.');assertPermission(ctx,PERMISSIONS.BILLING,'billing');};
export default async function stripeElements(app){
 app.post('/webhooks/stripe',async req=>handleStripeWebhook(req.rawBody,req.headers['stripe-signature']));
 app.get('/admin/stripe/payments',async req=>{await requirePlatformOwner(req.ctx);if(isMemoryMode())return [];return nativeDatabase().collection('payment_sessions').find({status:{$in:['stripe_pending','stripe_review','paid']},stripeStartedAt:{$exists:true}},{projection:{stripeIntentId:1,organizationId:1,plan:1,amount:1,status:1,stripeStartedAt:1,stripeReviewReason:1}}).sort({stripeStartedAt:-1}).limit(100).toArray();});
 app.post('/admin/stripe/payments/:id/check',async req=>{await requirePlatformOwner(req.ctx);const order=await nativeDatabase().collection('payment_sessions').findOne({_id:req.params.id});if(!order?.organizationId)throw forbidden('Payment not found.');return reconcileStripe({organizationId:order.organizationId,orderId:order._id});});
 app.get('/billing/stripe/availability',async req=>{billing(req.ctx);return stripeReadiness();});
 app.get('/billing/stripe/pending',async req=>{billing(req.ctx);if(isMemoryMode())return null;return pendingStripe(req.ctx.organizationId);});
 app.post('/billing/stripe/:id/prepare',async req=>{billing(req.ctx);return prepareStripe({organizationId:req.ctx.organizationId,orderId:req.params.id});});
 app.post('/billing/stripe/:id/cancel',async req=>{billing(req.ctx);return cancelStripe({organizationId:req.ctx.organizationId,orderId:req.params.id});});
 app.post('/billing/stripe/:id/status',async req=>{billing(req.ctx);return reconcileStripe({organizationId:req.ctx.organizationId,orderId:req.params.id});});
}
