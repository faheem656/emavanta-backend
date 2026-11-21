import { limitFor } from './definitions.js';

/**
 * Quota math is pure. The ledger lives in the database (usage_counters + messages),
 * not in a process-local token bucket: a bucket refills at a fixed rate, so after two
 * honest launches it would refuse a third even though the plan still had room.
 */
export const reserve = ({ plan, addons = {}, dimension, quantity = 1, used = {} }) => {
  const limit = limitFor(plan, dimension, addons);
  const already = Number(used[dimension] || 0);
  if (limit === -1) return { ok: true, limit: -1, used: already, remaining: -1 };
  const remaining = limit - already;
  if (quantity > remaining) return { ok: false, code: 'QUOTA_EXCEEDED', limit, used: already, remaining: Math.max(0, remaining) };
  return { ok: true, limit, used: already, remaining: remaining - quantity };
};

/** Read-only variant: previews and banners must never consume allowance. */
export const checkQuota = ({ plan, addons = {}, dimension, quantity = 1, used = {} }) => {
  const limit = limitFor(plan, dimension, addons);
  const already = Number(used[dimension] || 0);
  if (limit === -1) return { ok: true, limit: -1, used: already, remaining: -1, remainingAfter: -1 };
  return { ok: already + quantity <= limit, limit, used: already,
    remaining: Math.max(0, limit - already),
    remainingAfter: Math.max(0, limit - already - quantity) };
};

export const refund = ({ plan, addons = {}, dimension, quantity = 1, used = {} }) => {
  const limit = limitFor(plan, dimension, addons);
  const already = Number(used[dimension] || 0);
  return { ok: true, limit, used: Math.max(0, already - quantity), remaining: limit === -1 ? -1 : limit - Math.max(0, already - quantity) };
};

/** Ledger helpers shared by routing code and the load simulation. */
export const usageLedgerId = (organizationId, cycle) => `${organizationId}:${cycle}`;

export const DIMENSIONS = ['seats','mailboxes','contacts','sends','sequences','client_workspaces','campaigns','automations','api_calls','ai_credits','verification_credits','tracking_events','storage_gb'];

export const usageSnapshot = (plan, addons = {}) => Object.fromEntries(
  DIMENSIONS.map(d => [d, { limit: limitFor(plan, d, addons), used: 0 }])
);
