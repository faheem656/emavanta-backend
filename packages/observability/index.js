/** Shared SLO targets, metric dictionary and trace propagation for HTTP + jobs. */

export const SLOS = Object.freeze({
  api_availability: { target: 99.9, unit: '%', window: '30d', errorBudgetMinutes: 43.2, runbook: 'api-availability' },
  transactional_acceptance_p95_ms: { target: 2000, unit: 'ms', window: '7d', stream: 'transactional', runbook: 'slow-api' },
  delivery_event_lag_p95_min: { target: 5, unit: 'min', window: '24h', runbook: 'event-lag' },
  queue_wait_p95_min: { target: 5, unit: 'min', window: '1h', runbook: 'queue-backlog' },
  complaint_rate_max: { target: 0.001, unit: 'ratio', window: '24h', runbook: 'complaint-spike' }
});

export const RTO_RPO = Object.freeze({ rtoHours: 1, rpoMinutes: 5, restoreDrill: 'monthly', drDrill: 'quarterly' });

export const RUNBOOKS = Object.freeze({
  'api-availability': { owner: 'platform', steps: ['Check /api/v1/health on each pod', 'Check DB pool saturation', 'Fail over to healthy AZ', 'Post incident in status page'] },
  'queue-backlog': { owner: 'workers', steps: ['Inspect /admin/overview queue counts', 'Scale worker fleet by queue depth', 'Throttle marketing intake', 'Verify outbox relay is publishing'] },
  'event-lag': { owner: 'ingest', steps: ['Check provider webhook dashboard', 'Replay missed events', 'Run reconciliation job', 'Alert owner if lag > 15 min'] },
  'complaint-spike': { owner: 'deliverability', steps: ['Pause affected sending account', 'Suppress complained recipients', 'Review template/link changes', 'Require human approval to resume'] },
  'slow-api': { owner: 'platform', steps: ['Review slow query log', 'Check index usage', 'Reduce pool pressure', 'Enable backpressure response'] }
});

/** Metric names shared by dashboard, billing and reports (one definition everywhere). */
export const METRICS = Object.freeze({
  sent: 'Provider accepted a message (not a delivery guarantee)',
  delivered: 'Provider confirmed delivery via webhook or reconciliation',
  bounced: 'Hard or soft bounce classified by provider event',
  complained: 'Recipient marked spam; always suppress',
  opened: 'Open pixel hit; unreliable due to Apple Mail Privacy Protection (secondary metric)',
  clicked: 'Unique tracked-link click after dedupe',
  replied: 'Inbound reply matched by Message-ID / In-Reply-To / References',
  bounceRate: 'bounced / delivered (rolling window)',
  complaintRate: 'complained / delivered (rolling window; alert above 0.1%)'
});

/** Propagate W3C trace context through queue payloads. */
export const traceFromRequest = req => ({
  traceId: req?.id || req?.headers?.['x-request-id'] || undefined,
  traceparent: req?.headers?.traceparent,
  requestId: req?.id
});

export const traceFromJob = job => ({
  traceId: job?.data?.traceId || job?.id,
  traceparent: job?.data?.traceparent,
  jobId: job?.id
});

export const structuredLog = (level, message, fields = {}) => JSON.stringify({
  ts: new Date().toISOString(), level, message,
  ...Object.fromEntries(Object.entries(fields).filter(([k]) => !['password','token','secret','authorization'].includes(k.toLowerCase())))
});
