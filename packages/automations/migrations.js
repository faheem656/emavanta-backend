import { collection } from '../database/store.js';

/** Old active workflows were never executable. Pause them for explicit owner review. */
export async function prepareAutomationEngine() {
  const now = new Date().toISOString();
  const legacy = await collection('sequences').updateMany(
    { status: 'active', executionEnabled: { $ne: true }, deleted: { $ne: true } },
    { $set: { status: 'paused', executionEnabled: false, executionReviewRequired: true,
      executionReviewReason: 'Review this legacy workflow and explicitly activate it before any new email is sent.',
      legacyPausedAt: now } });
  // The pre-engine scheduler rows did not have the new idempotent enrollment/step
  // ledger. Cancel these rather than risk sending an unexpected duplicate.
  const legacyJobs = await collection('scheduled_jobs').updateMany(
    { type: 'sequence.step', status: { $in: ['pending', 'claimed'] } },
    { $set: { status: 'cancelled', cancelReason: 'automation_engine_upgrade_review', cancelledAt: now } });
  return { pausedLegacyFlows: legacy.modifiedCount || 0, cancelledLegacyJobs: legacyJobs.modifiedCount || 0 };
}
