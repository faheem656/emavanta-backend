import { getQueue } from '../queue/index.js';
import { stableHash } from '../shared/utils.js';

export async function enqueueAutomationStep({ organizationId, sequenceId, enrollmentId, stepIndex, runAt = new Date().toISOString(), replace = false }) {
  const due = Math.max(Date.now(), Date.parse(runAt) || Date.now());
  const jobId = `automation-step-${stableHash(enrollmentId, stepIndex, new Date(due).toISOString())}`;
  return getQueue('automation').add('automation.step', { organizationId, sequenceId, enrollmentId, stepIndex },
    { jobId, delay: due - Date.now(), retryFailed: true, ...(replace ? { replace: true } : {}) });
}
