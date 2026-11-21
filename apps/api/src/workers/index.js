import { startOutboxRelay } from './outboxRelay.js';
import { startCampaignRunner } from './campaignRunner.js';
import { startOutreachPacer } from './outreachPacer.js';
import { startIntakeWorker } from './intakeWorker.js';
import { startWebhookProcessor } from './webhookProcessor.js';
import { startContactMailWorker } from './contactMail.js';
import { startOtherWorkers } from './otherWorkers.js';

export const startWorkers = () => {
  startOutboxRelay();
  startContactMailWorker();
  startCampaignRunner();
  startIntakeWorker();
  startOutreachPacer();
  startWebhookProcessor();
  startOtherWorkers();
  console.log('[workers] registered: outbox, campaign, intake, outreach, webhook, webhook_out, import, analytics, scheduler, billing, report, reconcile');
};
