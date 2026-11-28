import { startOutboxRelay } from './outboxRelay.js';
import { startCampaignRunner } from './campaignRunner.js';
import { startOutreachPacer } from './outreachPacer.js';
import { startIntakeWorker } from './intakeWorker.js';
import { startWebhookProcessor } from './webhookProcessor.js';
import { startContactMailWorker } from './contactMail.js';
import { startOtherWorkers } from './otherWorkers.js';
import { startAutomationRunner } from './automationRunner.js';
import { startEmailVerificationWorker } from './emailVerificationWorker.js';

export const startWorkers = () => {
  startOutboxRelay();
  startContactMailWorker();
  startCampaignRunner();
  startAutomationRunner();
  startIntakeWorker();
  startOutreachPacer();
  startWebhookProcessor();
  startOtherWorkers();
  startEmailVerificationWorker();
  console.log('[workers] registered: outbox, campaign, intake, outreach, automation, webhook, webhook_out, import, analytics, scheduler, billing, report, reconcile, verify');
};
