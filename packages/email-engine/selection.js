import { ROTATION, ACCOUNT_STATUS } from '../shared/constants.js';
import { stableHash } from '../shared/utils.js';

export const eligibleAccounts = (accounts, { stream, now = new Date() } = {}) => (accounts || []).filter(a => {
  if (a.status && a.status !== ACCOUNT_STATUS.ACTIVE) return false;
  if (a.stream && stream && a.stream !== stream) return false;
  if (a.dailyCap && (a.sentToday || 0) >= a.dailyCap) return false;
  if (a.warmup && stream !== 'transactional') return false;
  if (a.tokenExpiresAt && Date.parse(a.tokenExpiresAt) < Date.now()) return false;
  if (a.activeHours && stream === 'outreach') {
    const h = now.getUTCHours();
    if (h < a.activeHours.start || h >= a.activeHours.end) return false;
  }
  return true;
});

/** Pure selection: returns { account, state } so callers can persist state per campaign. */
export const selectAccount = ({ accounts, strategy = ROTATION.STICKY_BY_CONTACT, contactId, state = {}, now }) => {
  const pool = eligibleAccounts(accounts, { now });
  if (!pool.length) return { account: null, state, reason: 'NO_ELIGIBLE_ACCOUNT' };
  let account;
  if (strategy === ROTATION.STICKY_BY_CONTACT) {
    // Purely deterministic: the same contact always lands on the same mailbox as long as
    // the pool is unchanged. It used to memoise every contact in `state.sticky`, which
    // grows without bound (100k contacts = 100k keys, past Mongo's 16 MB document limit).
    const remembered = state.sticky?.[contactId];
    const id = remembered && pool.some(a => a._id === remembered)
      ? remembered
      : pool[parseInt(stableHash(contactId).slice(0, 8), 16) % pool.length]._id;
    account = pool.find(a => a._id === id);
  } else if (strategy === ROTATION.LEAST_USED) {
    account = [...pool].sort((a, b) => (a.sentToday || 0) - (b.sentToday || 0))[0];
  } else if (strategy === ROTATION.WEIGHTED) {
    const total = pool.reduce((s, a) => s + (a.weight || 1), 0);
    let r = parseInt(stableHash(contactId, String(state.cursor || 0)).slice(0, 8), 16) % total;
    account = pool.find(a => { r -= (a.weight || 1); return r < 0; }) || pool[0];
  } else if (strategy === ROTATION.RANDOM_JITTER) {
    account = pool[parseInt(stableHash(contactId, String(now?.getTime?.() || Date.now())).slice(0, 8), 16) % pool.length];
  } else {
    const cursor = (state.cursor || 0) % pool.length;
    account = pool[cursor];
    state.cursor = cursor + 1;
  }
  return { account, state };
};
