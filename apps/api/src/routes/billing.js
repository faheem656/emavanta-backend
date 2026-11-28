import { assertPermission, PERMISSIONS } from '../../../../packages/security/rbac.js';
import { collection, scoped } from '../../../../packages/database/store.js';
import { PLANS, ADDONS, annualPrice, limitFor, effectiveAddons } from '../../../../packages/entitlements/definitions.js';
import { chargeInDashboard, tokenizeCard, detachCard } from '../../../../packages/entitlements/stripe.js';
import { chargeCard, chargeStoredCard, validateCard, cardSummary, maskPan, invoiceNumber,
  TEST_CARDS, MAX_SAVED_CARDS, storedCardStatus } from '../../../../packages/entitlements/payments.js';
import { config } from '../config.js';
import { audit } from '../plugins/audit.js';
import { AppError, badRequest, notFound, forbidden } from '../../../../packages/shared/errors.js';
import { newId } from '../../../../packages/shared/utils.js';

// The simulator is opt-in for automated tests only; a missing live processor never
// turns a paid upgrade into a simulated success in normal deployments.
// Raw-card handling is disabled outside isolated tests pending a PCI-safe integration.
const requireBilling = ctx => {if(ctx?.apiKeyId)throw forbidden('Use a signed-in billing account.');assertPermission(ctx,PERMISSIONS.BILLING,'billing');};
const isStripeEnabled = () => false;
const mockCardsAllowed = () => process.env.NODE_ENV === 'test' && process.env.MOCK_CARD_PAYMENTS === 'true';
const requireCardProcessor = () => {
  if (!isStripeEnabled() && !mockCardsAllowed()) throw new AppError(424, 'PAYMENTS_UNAVAILABLE', 'Card payments are not available right now.');
};

/**
 * One org record for every workspace — including the demo one. Add-on purchases and
 * plan changes are persisted, so raising a limit actually raises the limit.
 */
const getOrg = async ctx => {
  const id = ctx.organizationId;
  let org = await collection('organizations').findOne({ _id: id });
  if (!org) {
    org = await collection('organizations').create({
      _id: id, name: ctx.demo ? 'Demo Org' : 'Workspace',
      plan: ctx.demo ? 'growth' : 'free', cycle: `cycle-${new Date().toISOString().slice(0, 7)}`,
      addons: {}, settings: { timezone: 'UTC' }, createdAt: new Date().toISOString()
    });
  }
  return { addons: {}, ...org };
};

const limitsFor = (plan, addons) => Object.fromEntries(
  Object.keys(PLANS[plan].limits).map(d => [d, limitFor(plan, d, addons || {})]));

/** Amount in whole dollars for a plan or add-on purchase. */
const priceFor = ({ kind, plan, code, quantity = 1, interval = 'monthly' }) => {
  if (kind === 'plan') {
    const p = PLANS[plan];
    if (!p) throw badRequest('Unknown plan');
    const amount = interval === 'annual' ? annualPrice(plan) : p.priceMonthly;
    return { amount, currency: 'usd', interval: interval === 'annual' ? 'year' : 'month',
      label: `${p.name} plan`, title: p.name,
      description: `${p.name} plan · ${interval === 'annual' ? 'one-year term' : 'one-month term'} · no automatic renewal` };
  }
  const addon = ADDONS[code];
  if (!addon) throw badRequest('Unknown add-on');
  const qty = Math.max(1, Math.min(20, Number(quantity) || 1));
  return { amount: addon.price * qty, currency: 'usd', interval: 'month',
    label: qty > 1 ? `${addon.label || addon.code} × ${qty}` : (addon.label || addon.code),
    title: addon.label || addon.code,
    description: addon.oneTime
      ? `${addon.label || addon.code} × ${qty} · one-time purchase, credits never expire`
      : `${addon.label || addon.code} × ${qty} · one-month term, no automatic renewal`,
    quantity: qty };
};

/**
 * Store a validated card as a token. PAN and CVC are dropped immediately; only the
 * fingerprint, brand, last four and expiry survive. The first card becomes the
 * default automatically.
 */
const savePaymentMethod = async (ctx, card, { allowDuplicate = false } = {}) => {
  const summary = cardSummary(card);
  if (!summary.ok) throw new AppError(422, 'CARD_INVALID', 'Check the card details', { fields: summary.fields });
  const existing = await scoped('payment_methods', ctx).find({});
  if (existing.some(m => m.fingerprint === summary.fingerprint)) {
    if (allowDuplicate) return existing.find(m => m.fingerprint === summary.fingerprint);
    throw new AppError(409, 'CARD_EXISTS', `That card is already saved (•••• ${summary.last4}).`);
  }
  if (existing.length >= MAX_SAVED_CARDS) {
    throw new AppError(409, 'CARD_LIMIT', `You can keep ${MAX_SAVED_CARDS} cards on file — remove one first.`);
  }
  // With real keys the card becomes a Stripe token we can charge later; the PAN is
  // still never written to our database.
  let token = null;
  let brand = summary.brand;
  let last4 = summary.last4;
  if (isStripeEnabled()) {
    const made = await tokenizeCard(card, summary.name);
    if (!made.ok) throw new AppError(402, made.code || 'CARD_INVALID', made.message || 'That card could not be saved.');
    token = made.id; brand = made.brand; last4 = made.last4;
  }
  return scoped('payment_methods', ctx).create({ _id: newId(), brand, last4, unusable: false,
    expMonth: summary.expMonth, expYear: summary.expYear, name: summary.name, fingerprint: summary.fingerprint,
    stripeId: token, isDefault: existing.length === 0, addedBy: ctx.user?.email || null,
    createdAt: new Date().toISOString() });
};

export default async function billingRoutes(app) {
  app.get('/billing/plans', async () => ({ currency: 'usd', plans: Object.entries(PLANS).map(([code, p]) => ({
    code, name: p.name, monthly: p.priceMonthly, yearly: annualPrice(code), limits: p.limits })), addons: ADDONS }));

  app.get('/billing/subscription', async req => {
    const org = await getOrg(req.ctx);
    return { plan: org.plan, cycle: org.cycle, addons: effectiveAddons(org),
      limits: limitsFor(org.plan, effectiveAddons(org)), stripeEnabled: isStripeEnabled(),
      startedAt:org.planStartedAt || null,
      expiresAt:['crypto','stripe','platform_manual_override'].includes(org.planChangeSource) ? (org.planExpiresAt || null) : null,
      previousTermEnd: ['crypto_expired','stripe_expired','platform_manual_override_expired'].includes(org.planChangeSource) ? org.planExpiresAt || null : null,
      interval:org.planInterval || null, source:org.planChangeSource || (org.plan==='free' ? 'free' : 'unknown'), lastPaymentAt:org.lastPaymentAt || null, autoRenew:false };
  });

  /* ---------------------------------------------------------------- */
  /* Checkout: a session must be created AND paid. Nothing is granted  */
  /* before `POST /billing/session/:id/pay` returns ok.                */
  /* ---------------------------------------------------------------- */

  app.post('/billing/session', async req => {
    requireBilling(req.ctx);
    const { kind = 'plan', plan, code, quantity = 1, interval = 'monthly' } = req.body || {};
    if(!['plan','addon'].includes(kind))throw badRequest('Choose a valid order type.');
    if(kind==='addon' && (!Number.isInteger(Number(quantity)) || Number(quantity)<1 || Number(quantity)>20))throw badRequest('Choose an add-on quantity between 1 and 20.');
    if (kind === 'plan' && plan === 'free') {
      // Downgrading to Free costs nothing — it is a cancellation, not a purchase.
      const org = await getOrg(req.ctx);
      await collection('organizations').updateOne({ _id: req.ctx.organizationId },
        { $set: { plan: 'free', addons: {}, canceledAt: new Date().toISOString(), planStartedAt:new Date().toISOString(), planExpiresAt:null, planInterval:null, planChangeSource:'free' } });
      await audit(req.ctx, 'billing.downgrade', 'organization', { from: org.plan, to: 'free' });
      return { free: true, plan: 'free', limits: limitsFor('free', {}) };
    }

    // Payment is collected in the dashboard itself — there is no hosted checkout page
    // to navigate to, with or without Stripe keys configured.
    const price = priceFor({ kind, plan, code, quantity, interval });

    const session = await collection('payment_sessions').create({
      _id: newId(), organizationId: req.ctx.organizationId, createdByUserId: req.ctx.user.id, kind,
      plan: kind === 'plan' ? plan : null, code: kind === 'addon' ? code : null,
      quantity: price.quantity || Number(quantity) || 1, interval: price.interval,
      amount: price.amount, currency: price.currency, description: price.description,
      status: 'pending', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString()
    });
    return { sessionId: session._id, amount: price.amount, currency: price.currency,
      description: price.description, interval: price.interval,
      label: price.label, title: price.title, stripeEnabled: isStripeEnabled(),
      stripeTestMode: /^sk_test_/.test(String(process.env.STRIPE_SECRET_KEY || '').trim()), inApp: true };
  });

  app.get('/billing/session/:id', async req => {
    const session = await scoped('payment_sessions', req.ctx).findOne({ _id: req.params.id });
    if (!session) throw notFound('Checkout session not found');
    return session;
  });

  app.post('/billing/session/:id/pay', async req => {
    requireBilling(req.ctx);
    requireCardProcessor();
    const session = await scoped('payment_sessions', req.ctx).findOne({ _id: req.params.id });
    if (!session) throw notFound('Checkout session not found');
    if (session.status === 'paid') return { ok: true, alreadyPaid: true, invoiceId: session.invoiceId };
    if (session.status === 'canceled') throw badRequest('This checkout was canceled');
    if (session.expiresAt && Date.parse(session.expiresAt) < Date.now()) {
      await scoped('payment_sessions', req.ctx).updateOne({ _id: session._id }, { $set: { status: 'expired' } });
      throw badRequest('This checkout expired — start again');
    }
    const { card = {}, paymentMethodId, saveCard } = req.body || {};

    let charge;
    let method;
    if (paymentMethodId) {
      // paying with a card that is already on file — a token charge, no PAN involved
      method = await scoped('payment_methods', req.ctx).findOne({ _id: paymentMethodId });
      if (!method) throw notFound('That saved card is no longer on file — add it again.');
      charge = isStripeEnabled()
        ? await chargeInDashboard({ paymentMethodId: method.stripeId, amount: session.amount,
            currency: session.currency, description: session.description })
        : chargeStoredCard({ method, amount: session.amount, currency: session.currency, description: session.description });
      // A saved card that cannot be charged must never trap the buyer on this screen:
      // flag it, drop it as the default, and tell the client to fall back to a new card.
      if (!charge.ok && ['CARD_EXPIRED', 'CARD_DECLINED', 'CARD_MISSING'].includes(charge.code)) {
        await scoped('payment_methods', req.ctx).updateOne({ _id: method._id },
          { $set: { unusable: true, unusableReason: charge.code, unusableAt: new Date().toISOString(), isDefault: false } });
        const remaining = (await scoped('payment_methods', req.ctx).find({})).filter(m => !m.unusable);
        if (remaining.length && !remaining.some(m => m.isDefault)) {
          await scoped('payment_methods', req.ctx).updateOne({ _id: remaining[0]._id }, { $set: { isDefault: true } });
        }
      }
    } else {
      const check = validateCard(card);
      if (!check.ok) throw new AppError(422, 'CARD_INVALID', 'Check the card details', { fields: check.errors });
      charge = isStripeEnabled()
        ? await chargeInDashboard({ card, amount: session.amount, currency: session.currency, description: session.description })
        : chargeCard({ card, amount: session.amount, currency: session.currency, description: session.description });
    }
    if (!charge.ok) {
      await scoped('payment_sessions', req.ctx).updateOne({ _id: session._id },
        { $set: { lastError: charge.code, attempts: (session.attempts || 0) + 1 } });
      const recoverable = ['CARD_EXPIRED', 'CARD_DECLINED', 'CARD_MISSING'].includes(charge.code);
      throw new AppError(402, charge.code,
        recoverable ? `${charge.message} Nothing was charged — add a card below and pay again.` : charge.message,
        recoverable ? { fallbackToNewCard: true } : undefined);
    }

    const methodLabel = `${charge.brand} ${(charge.last4 && `•••• ${charge.last4}`) || ''}`.trim();

    // Saving the card happens only AFTER a successful charge, so a declined card is
    // never stored. Only brand/last4/expiry/fingerprint are kept — never the PAN.
    let savedMethod = method || null;
    if (!method && (saveCard === true || saveCard === 'true')) {
      savedMethod = await savePaymentMethod(req.ctx, card, { allowDuplicate: true });
    }

    const org = await getOrg(req.ctx);
    let nextPlan = org.plan;
    let nextAddons = { ...(org.addons || {}) };
    let nextVerifyCredits = Number(org.verifyCredits || 0);
    if (session.kind === 'plan') {
      if (!PLANS[session.plan]) throw badRequest('Unknown plan');
      nextPlan = session.plan;
    } else {
      const addonDef = ADDONS[session.code];
      if (addonDef?.grants === 'verifyCredits') {
        // Verification credit PACKS: one-time lifetime balance only — they must
        // NOT enter org.addons (that path feeds monthly limit math).
        nextVerifyCredits += addonDef.amount * (session.quantity || 1);
      } else {
        nextAddons[session.code] = (nextAddons[session.code] || 0) + (session.quantity || 1);
      }
    }

    const invoiceSeq = (await scoped('invoices', req.ctx).countDocuments({})) + 1;
    const invoice = await scoped('invoices', req.ctx).create({
      _id: newId(), number: invoiceNumber(invoiceSeq), amount: session.amount, currency: session.currency,
      description: session.description, status: 'paid', date: new Date().toISOString().slice(0, 10),
      paidAt: charge.paidAt, method: methodLabel, chargeId: charge.id, paymentMethodId: savedMethod?._id || null,
      sessionId: session._id, createdAt: new Date().toISOString()
    });

    await collection('organizations').updateOne({ _id: req.ctx.organizationId },
      { $set: { plan: nextPlan, addons: nextAddons, verifyCredits: nextVerifyCredits, lastPaymentAt: charge.paidAt } });
    await scoped('payment_sessions', req.ctx).updateOne({ _id: session._id },
      { $set: { status: 'paid', paidAt: charge.paidAt, invoiceId: invoice._id, card: methodLabel } });
    await audit(req.ctx, 'billing.paid', 'invoice', { invoice: invoice.number, amount: session.amount,
      kind: session.kind, plan: nextPlan, code: session.code || null });

    return { ok: true, invoice, plan: nextPlan, addons: nextAddons, live: isStripeEnabled(),
      limits: limitsFor(nextPlan, nextAddons), subscription: { plan: nextPlan, addons: nextAddons },
      savedMethod: savedMethod ? { _id: savedMethod._id, brand: savedMethod.brand, last4: savedMethod.last4,
        expMonth: savedMethod.expMonth, expYear: savedMethod.expYear,
        isDefault: !!savedMethod.isDefault } : null };
  });

  app.post('/billing/session/:id/cancel', async req => {
    requireBilling(req.ctx);
    const session = await scoped('payment_sessions', req.ctx).findOne({ _id: req.params.id });
    if (!session) throw notFound('Checkout session not found');
    if (session.status !== 'pending' || session.cryptoNonce) throw badRequest('This checkout cannot be canceled after wallet preparation. Contact support if funds were sent.');
    const result = await scoped('payment_sessions', req.ctx).updateOne({ _id: session._id, status: 'pending', cryptoNonce: { $exists: false } }, { $set: { status: 'canceled' } });
    if (!result.matchedCount) throw badRequest('This checkout can no longer be canceled.');
    return { ok: true, status: 'canceled' };
  });

  /**
   * Legacy alias kept for old clients: returns a normal in-dashboard checkout, never a
   * link to a hosted payment page.
   */
  app.post('/billing/checkout', async req => {
    requireBilling(req.ctx);
    const { plan = 'growth', interval = 'monthly' } = req.body || {};
    if (!PLANS[plan]) throw badRequest('Unknown plan');
    return { mock: true, requiresPayment: true, inApp: true,
      checkout: `/dashboard/billing?plan=${plan}&interval=${interval}`,
      amount: interval === 'annual' ? annualPrice(plan) : PLANS[plan].priceMonthly };
  });

  /** Card management lives in the billing page — there is no external portal. */
  app.post('/billing/portal', async req => {
    requireBilling(req.ctx);
    const methods = await scoped('payment_methods', req.ctx).find({});
    return { inApp: true, url: '/dashboard/billing#payment-methods', cards: methods.length };
  });

  /* ---------------------------------------------------------------- */
  /* Saved cards: list, add, set default, remove                       */
  /* ---------------------------------------------------------------- */

  app.get('/billing/payment-methods', async req => {
    const rows = await scoped('payment_methods', req.ctx).find({}, { sort: { createdAt: 1 } });
    const methods = rows
      .map(({ _id, brand, last4, expMonth, expYear, name, isDefault, createdAt, addedBy, declines }) => ({
        _id, brand, last4, expMonth, expYear, name, isDefault: !!isDefault, createdAt, addedBy,
        ...storedCardStatus({ expMonth, expYear, declines })
      }))
      .sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    return { methods, max: MAX_SAVED_CARDS, canAdd: methods.length < MAX_SAVED_CARDS };
  });

  app.post('/billing/payment-methods', async req => {
    requireBilling(req.ctx);
    requireCardProcessor();
    const summary = cardSummary(req.body?.card || {});
    if (!summary.ok) throw new AppError(422, 'CARD_INVALID', 'Check the card details', { fields: summary.fields });
    const method = await savePaymentMethod(req.ctx, req.body.card, { allowDuplicate: false });
    await audit(req.ctx, 'billing.card.added', 'payment_method', { brand: method.brand, last4: method.last4 });
    const rows = await scoped('payment_methods', req.ctx).find({});
    return { ok: true, method: { _id: method._id, brand: method.brand, last4: method.last4,
      expMonth: method.expMonth, expYear: method.expYear, name: method.name, isDefault: method.isDefault },
      count: rows.length, max: MAX_SAVED_CARDS };
  });

  app.patch('/billing/payment-methods/:id', async req => {
    requireBilling(req.ctx);
    const method = await scoped('payment_methods', req.ctx).findOne({ _id: req.params.id });
    if (!method) throw notFound('Card not found');
    const wantsDefault = req.body?.isDefault === true || req.body?.isDefault === 'true';
    if (wantsDefault) {
      await scoped('payment_methods', req.ctx).updateMany({}, { $set: { isDefault: false } });
      await scoped('payment_methods', req.ctx).updateOne({ _id: method._id }, { $set: { isDefault: true } });
      await audit(req.ctx, 'billing.card.default', 'payment_method', { last4: method.last4 });
    }
    if (req.body?.name && String(req.body.name).trim()) {
      await scoped('payment_methods', req.ctx).updateOne({ _id: method._id }, { $set: { name: String(req.body.name).trim() } });
    }
    const updated = await scoped('payment_methods', req.ctx).findOne({ _id: method._id });
    return { ok: true, method: { _id: updated._id, brand: updated.brand, last4: updated.last4,
      expMonth: updated.expMonth, expYear: updated.expYear, name: updated.name, isDefault: !!updated.isDefault } };
  });

  app.delete('/billing/payment-methods/:id', async req => {
    requireBilling(req.ctx);
    const method = await scoped('payment_methods', req.ctx).findOne({ _id: req.params.id });
    if (!method) throw notFound('Card not found');
    await detachCard(method.stripeId);
    await scoped('payment_methods', req.ctx).deleteOne({ _id: method._id });
    // never leave the workspace without a default card if one is still on file
    if (method.isDefault) {
      const rest = await scoped('payment_methods', req.ctx).find({}, { sort: { createdAt: 1 } });
      if (rest[0]) await scoped('payment_methods', req.ctx).updateOne({ _id: rest[0]._id }, { $set: { isDefault: true } });
    }
    await audit(req.ctx, 'billing.card.removed', 'payment_method', { last4: method.last4 });
    const remaining = await scoped('payment_methods', req.ctx).find({});
    return { ok: true, remaining: remaining.length };
  });

  /**
   * Add-ons are only applied against a PAID session — passing `sessionId` proves the
   * card was charged. Calling this without one returns 402 and changes nothing.
   */
  app.post('/billing/addon', async req => {
    requireBilling(req.ctx);
    const { code, quantity = 1, sessionId } = req.body || {};
    const addon = ADDONS[code];
    if (!addon) throw badRequest('Unknown add-on');
    if (!sessionId) {
      const price = priceFor({ kind: 'addon', code, quantity });
      throw new AppError(402, 'PAYMENT_REQUIRED',
        `Payment is required first — ${addon.label || code} is $${price.amount}/mo. Nothing has been added yet.`,
        { amount: price.amount, currency: 'usd', description: price.description, kind: 'addon', code });
    }
    const session = await scoped('payment_sessions', req.ctx).findOne({ _id: sessionId, kind: 'addon', status: 'paid' });
    if (!session || session.code !== code) throw new AppError(402, 'PAYMENT_REQUIRED', 'That checkout has not been paid for this add-on.');

    const org = await getOrg(req.ctx);
    const limits = limitsFor(org.plan, effectiveAddons(org));
    await audit(req.ctx, 'billing.addon.purchase', 'organization', { code, quantity, sessionId });
    return { ok: true, addons: effectiveAddons(org), limits,
      note: `Paid ${session.amount} ${session.currency.toUpperCase()} — ${addon.label || code} is now active.` };
  });

  app.get('/billing/usage', async req => {
    const org = await getOrg(req.ctx);
    const counter = await collection('usage_counters').findOne({ _id: `${req.ctx.organizationId}:${org.cycle}` });
    const planAllowance = Number(PLANS[org.plan]?.limits?.verification_credits ?? 0);
    const cycleUsed = Number(counter?.verification_credits || 0);
    return { cycle: org.cycle, plan: org.plan, addons: effectiveAddons(org),
      limits: limitsFor(org.plan, effectiveAddons(org)),
      used: { sends: Math.max(Number(counter?.sends || 0),
          await scoped('messages', req.ctx).countDocuments({})),
        contacts: await scoped('contacts', req.ctx).countDocuments({ deleted: { $ne: true } }),
        seats: await scoped('memberships', req.ctx).countDocuments({ status: 'active' }),
        verification_credits: cycleUsed },
      verification: {
        planAllowance, cycleUsed,
        planRemaining: planAllowance === -1 ? -1 : Math.max(0, planAllowance - cycleUsed),
        packBalance: Number(org.verifyCredits || 0)
      } };
  });

  /** What the demo install accepts, so the checkout form can say it plainly. */
  app.get('/billing/test-cards', async () => { if (process.env.NODE_ENV !== 'test') throw notFound('Not found'); return { stripe: false, cards: TEST_CARDS }; });
}
