import { scoped } from '../../../../packages/database/store.js';
import { registerWorker, getQueue } from '../../../../packages/queue/index.js';
import { intakeChunk, INTAKE_CHUNK } from '../../../../packages/scale/intake.js';

/**
 * Campaign intake worker: one job per chunk of 2 000 contacts, self-rescheduling.
 * Millions of recipients become ~500 short jobs instead of one giant transaction,
 * so the API answers immediately and memory stays flat.
 */
export const startIntakeWorker = () => registerWorker('campaign_intake', async payload => {
  const { organizationId, campaignId, offset = 0 } = payload;
  const ctx = { organizationId };
  const campaign = await scoped('campaigns', ctx).findOne({ _id: campaignId });
  if (!campaign) return;
  const intake = campaign.intake || {};
  if (intake.status === 'cancelled' || intake.status === 'done') return;

  const result = await intakeChunk({
    ...payload,
    organizationId, campaignId,
    limit: payload.limit || INTAKE_CHUNK
  });

  const done = intake.done ? Number(intake.done) + result.added : result.added;
  const exhausted = result.done || result.added === 0;
  await scoped('campaigns', ctx).updateOne({ _id: campaignId }, {
    $set: {
      'intake.done': done,
      'intake.status': exhausted ? 'done' : 'running',
      'intake.updatedAt': new Date().toISOString(),
      ...(exhausted ? { 'intake.finishedAt': new Date().toISOString() } : {})
    }
  });

  if (!exhausted) {
    const next = offset + (result.added || payload.limit || INTAKE_CHUNK);
    // Deterministic ids: the same contact can never be added twice even if a chunk retries.
    await getQueue('campaign_intake').add('campaign.intake',
      { ...payload, offset: next, after: result.nextAfter || null },
      { jobId: `intake-${campaignId}-${result.nextAfter || next}` });
  }
});
