import Stripe from 'stripe';
import { PLANS, ADDONS, annualPrice } from './definitions.js';

let stripe;
export const getStripe = () => {
  if (!stripe && process.env.STRIPE_SECRET_KEY) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
};
export const isStripeEnabled = () => !!String(process.env.STRIPE_SECRET_KEY || '').trim();

export const createCheckout = async ({ organizationId, email, plan, interval = 'monthly' }) => {
  if (!isStripeEnabled()) return { id: `mock_cs_${organizationId}`, url: `/dashboard/billing?plan=${plan}`, mock: true };
  const s = getStripe();
  const priceData = { currency: 'usd', product_data: { name: `${PLANS[plan].name} plan` }, unit_amount: PLANS[plan].priceMonthly * 100,
    recurring: { interval: interval === 'yearly' ? 'year' : 'month' } };
  if (interval === 'yearly') priceData.unit_amount = annualPrice(plan) * 100;
  const session = await s.checkout.sessions.create({ mode: 'subscription', customer_email: email,
    line_items: [{ price_data: priceData, quantity: 1 }], success_url: `${process.env.APP_URL || 'http://localhost:3000'}/dashboard/billing?checkout=success`,
    cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/dashboard/billing?checkout=canceled`,
    metadata: { organizationId, plan, interval } });
  return { id: session.id, url: session.url };
};

export const createPortal = async customerId => {
  if (!isStripeEnabled()) return { url: '/dashboard/billing?portal=1', mock: true };
  const s = getStripe();
  const session = await s.billingPortal.sessions.create({ customer: customerId, return_url: `${process.env.APP_URL || 'http://localhost:3000'}/dashboard/billing` });
  return { url: session.url };
};

export const planFromSubscription = subscription => {
  const price = subscription?.items?.data?.[0]?.price;
  const name = price?.product?.name?.toLowerCase() || '';
  return Object.keys(PLANS).find(p => name.includes(p)) || 'growth';
};

export const addonPrice = code => ADDONS[code]?.price || 0;

/* ------------------------------------------------------------------ */
/* In-dashboard card processing (no hosted checkout page)              */
/* ------------------------------------------------------------------ */

/**
 * With STRIPE_SECRET_KEY set we still never send the user to Stripe's page: the card
 * form in the dashboard posts to us and we create + confirm a PaymentIntent server
 * side. Without keys the caller falls back to the built-in simulator.
 */
const stripeError = err => {
  const code = err?.code || err?.raw?.code || 'PROCESSING_ERROR';
  if (code === 'card_declined' || err?.type === 'StripeCardError') {
    const reason = err?.decline_code || err?.raw?.decline_code || '';
    return { ok: false, code: reason === 'insufficient_funds' ? 'INSUFFICIENT_FUNDS' : 'CARD_DECLINED',
      message: err?.message || 'Your card was declined. Try another card.' };
  }
  if (code === 'expired_card') return { ok: false, code: 'CARD_EXPIRED', message: 'That card has expired.' };
  if (code === 'incorrect_cvc') return { ok: false, code: 'CARD_INVALID', message: 'The CVC does not match the card.' };
  return { ok: false, code: 'PROCESSING_ERROR', message: err?.message || 'The payment processor could not complete this charge.' };
};

/** Card -> Stripe PaymentMethod token. The PAN only lives in this request. */
export const tokenizeCard = async (card, name) => {
  const s = getStripe();
  const [mm, yy] = String(card.expiry || '').split('/');
  const yearNum = Number(yy);
  const pm = await s.paymentMethods.create({ type: 'card', card: {
    number: String(card.number || '').replace(/\s/g, ''), exp_month: Number(mm), exp_year: yearNum < 100 ? 2000 + yearNum : yearNum, cvc: String(card.cvc || '')
  }, billing_details: { name: name || card.name } });
  return { ok: true, id: pm.id, brand: pm.card?.brand || 'card', last4: pm.card?.last4 || '',
    expMonth: pm.card?.exp_month, expYear: pm.card?.exp_year };
};

/** Charge a card token (or a brand-new card) without leaving the dashboard. */
export const chargeInDashboard = async ({ card, paymentMethodId, amount, currency = 'usd', description, customerId }) => {
  if (!isStripeEnabled()) return { ok: false, code: 'STRIPE_DISABLED', message: 'Stripe is not configured.' };
  const s = getStripe();
  try {
    let token = paymentMethodId;
    if (!token) {
      const made = await tokenizeCard(card);
      token = made.id;
    }
    const intent = await s.paymentIntents.create({
      amount: Math.round(Number(amount) * 100), currency, confirm: true,
      payment_method: token, description,
      ...(customerId ? { customer: customerId, off_session: true } : { automatic_payment_methods: { enabled: false } })
    });
    if (intent.status !== 'succeeded') {
      return { ok: false, code: 'PROCESSING_ERROR', message: `Payment is ${intent.status} — nothing was taken.` };
    }
    return { ok: true, id: intent.id, chargeId: intent.latest_charge, amount: Number(amount), currency,
      brand: intent.charges?.data?.[0]?.payment_method_details?.card?.brand || 'card',
      last4: intent.charges?.data?.[0]?.payment_method_details?.card?.last4 || '',
      stripePaymentMethodId: token, paidAt: new Date().toISOString(), test: !String(process.env.STRIPE_SECRET_KEY).startsWith('sk_live') };
  } catch (err) {
    return stripeError(err);
  }
};

export const detachCard = async paymentMethodId => {
  if (!isStripeEnabled() || !paymentMethodId) return { ok: true, mock: true };
  try { await getStripe().paymentMethods.detach(paymentMethodId); return { ok: true }; }
  catch (err) { return { ok: false, message: err?.message || 'Could not detach the card' }; }
};
