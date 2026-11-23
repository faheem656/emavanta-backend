import { collection } from '../database/store.js';
import { stableHash } from '../shared/utils.js';
import { blocksToHtml, DEFAULT_EMAIL_STYLES } from '../email-engine/template.js';
import { campaignSchema, sequenceSchema, templateSchema } from '../validation/index.js';

const CONTENT_VERSION = 2;
const FORM_CONTENT_VERSION = 2;
const starterTemplates = [
  {
    key: 'welcome-subscriber', category: 'Welcome & onboarding', name: 'Welcome · new subscriber',
    subject: 'Welcome, {{first_name|there}} — here is what to expect',
    heading: 'A thoughtful welcome',
    intro: 'Thanks for joining {{company|our updates}}. We will keep this useful, relevant, and easy to leave at any time.',
    body: 'Start with the guide below, or reply to this email and tell us what would be most helpful for your team.',
    cta: 'Read the getting-started guide'
  },
  {
    key: 'product-launch', category: 'Product updates', name: 'Product launch · announcement',
    subject: 'Introducing our latest release',
    heading: 'A new release, built for your next step',
    intro: 'We have shipped an update designed to make everyday work clearer for {{company|your team}}.',
    body: 'Take a look at the release notes to see what changed, what is optional, and how to try it at your own pace.',
    cta: 'Explore the release notes'
  },
  {
    key: 'monthly-update', category: 'Product updates', name: 'Monthly product update · digest',
    subject: 'Product update: what changed this month',
    heading: 'Your monthly product brief',
    intro: 'Here is a concise look at the improvements, fixes, and useful resources added this month.',
    body: 'Pick the changes that matter to your workflow. You can share the notes with colleagues or simply save them for later.',
    cta: 'Read this month’s updates'
  },
  {
    key: 'webinar-invite', category: 'Events', name: 'Webinar · invitation',
    subject: 'An invitation for {{company|your team}}',
    heading: 'Join us for a practical session',
    intro: 'We are hosting a focused session on a real-world way to improve your team’s workflow, with time for questions.',
    body: 'Add the event date, time, host, and agenda before sending. Registration is optional and you can forward this invitation to a colleague.',
    cta: 'View the event details'
  },
  {
    key: 'webinar-reminder', category: 'Events', name: 'Webinar · event reminder',
    subject: 'A quick reminder about the upcoming session',
    heading: 'A quick event reminder',
    intro: 'A reminder about the session you registered for. Add the confirmed date, time, and joining link before sending.',
    body: 'If the timing no longer works, update your registration using the event page. We will make the notes available afterward.',
    cta: 'Open the event page'
  },
  {
    key: 'event-follow-up', category: 'Events', name: 'Webinar · resources and follow-up',
    subject: 'Your session resources and next steps',
    heading: 'Thanks for joining us',
    intro: 'Thanks for spending time with us. Here are the promised notes and resources from the session.',
    body: 'If you could not attend live, the recap is available below. Reply with a question and we will point you to the right section.',
    cta: 'View the recap and resources'
  },
  {
    key: 'trial-first-win', category: 'Customer lifecycle', name: 'Trial · first useful result',
    subject: 'A simple next step for your workspace',
    heading: 'Start with one useful outcome',
    intro: 'You do not need to configure everything at once. Choose one outcome for {{company|your team}} and follow the short setup guide.',
    body: 'The checklist covers the essentials and leaves advanced options until you need them.',
    cta: 'Open the setup checklist'
  },
  {
    key: 'customer-check-in', category: 'Customer lifecycle', name: 'Customer success · check-in',
    subject: 'How is everything going, {{first_name|there}}?',
    heading: 'A quick check-in',
    intro: 'We wanted to check whether the current setup is working well for {{company|your team}}.',
    body: 'Tell us what is going smoothly, where you are stuck, or what you would like to do next. A short reply is enough.',
    cta: 'Share an update'
  },
  {
    key: 'renewal-review', category: 'Customer lifecycle', name: 'Renewal · value review',
    subject: 'A useful review before your next term',
    heading: 'Let’s review what is working',
    intro: 'Before your next term, let’s make time to review your goals, current usage, and any changes you may want.',
    body: 'Add the renewal date and a short account-specific summary. This note is intended to start a conversation, not to assume a renewal decision.',
    cta: 'Schedule a review'
  },
  {
    key: 'reengagement', category: 'Customer lifecycle', name: 'Re-engagement · preference check',
    subject: 'Would you still like to hear from us?',
    heading: 'Is this still useful?',
    intro: 'It has been a while since we last heard from you. We would rather send less than fill your inbox with messages you do not need.',
    body: 'Choose your email preferences or reply with the topics you care about. You can unsubscribe below whenever you like.',
    cta: 'Review email preferences'
  },
  {
    key: 'post-purchase', category: 'Customer lifecycle', name: 'After purchase · next steps',
    subject: 'Thank you — here are your next steps',
    heading: 'A clear start after purchase',
    intro: 'Thank you for choosing us. This note gathers the practical details your team needs to get started.',
    body: 'Add the correct setup link, support contact, and any account-specific instructions before sending.',
    cta: 'View your setup guide'
  },
  {
    key: 'feedback-request', category: 'Customer lifecycle', name: 'Feedback · thoughtful request',
    subject: 'Could you share a little feedback?',
    heading: 'Help us make the experience better',
    intro: 'You have seen the product in your own workflow, and your perspective can help us improve it.',
    body: 'If you have a moment, tell us what has been useful and what could be simpler. We read every response.',
    cta: 'Share your feedback'
  }
];

const starterCampaigns = [
  { key: 'new-subscriber-welcome', name: 'New subscriber · welcome', description: 'A permission-based first touch that sets expectations and points subscribers to a useful starting resource.', template: 'welcome-subscriber' },
  { key: 'product-launch', name: 'Product release · announcement', description: 'Announce a meaningful release with clear context, release notes, and an optional next step.', template: 'product-launch' },
  { key: 'monthly-product-brief', name: 'Monthly product brief', description: 'A concise monthly update for opted-in customers who want to follow product changes.', template: 'monthly-update' },
  { key: 'webinar-invitation', name: 'Webinar · invitation', description: 'Invite the right audience to an educational event; add confirmed date, time, host, and agenda before launch.', template: 'webinar-invite' },
  { key: 'webinar-reminder', name: 'Webinar · reminder', description: 'A short reminder for registered attendees. Confirm the event timing and joining details first.', template: 'webinar-reminder' },
  { key: 'post-event-follow-up', name: 'Webinar · resource follow-up', description: 'Thank attendees and share the promised recap and resources without assuming they attended live.', template: 'event-follow-up' },
  { key: 'trial-first-win', name: 'Trial · first useful result', description: 'Help new trial users reach one practical outcome with a focused setup guide.', template: 'trial-first-win' },
  { key: 'customer-success-check-in', name: 'Customer success · check-in', description: 'Open a helpful conversation about progress, friction, and the next customer goal.', template: 'customer-check-in' },
  { key: 'renewal-value-review', name: 'Renewal · value review', description: 'Start an account-specific review before renewal; personalize the date and value summary.', template: 'renewal-review' },
  { key: 'reengagement-preferences', name: 'Re-engagement · preference check', description: 'Respectfully confirm whether an inactive subscriber still wants updates and make preferences easy to change.', template: 'reengagement' }
];

const starterForms = [
  {
    key: 'newsletter-signup', category: 'Audience growth', name: 'Newsletter · weekly insights',
    headline: 'A smarter start to your week',
    description: 'Get one thoughtful email with practical ideas, useful links, and product news. Choose your own pace at any time.',
    submitLabel: 'Join the newsletter', successMessage: 'You are on the list. Look out for a useful first note soon.',
    tags: ['newsletter', 'website'], accent: '#3158c9', layout: 'card',
    fields: [
      { key: 'email', label: 'Work email', type: 'email', required: true, placeholder: 'you@company.com', locked: true },
      { key: 'first_name', label: 'First name', type: 'text', required: false, placeholder: 'Alex' },
      { key: 'topics', label: 'Topics you care about', type: 'select', required: false, placeholder: 'Choose a topic', options: ['Product ideas', 'Customer stories', 'Events and webinars', 'A little of everything'] },
      { key: 'email_updates_consent', label: 'I agree to receive the weekly newsletter. I can unsubscribe at any time.', type: 'checkbox', required: true }
    ]
  },
  {
    key: 'demo-request', category: 'Sales & demos', name: 'Product demo · request',
    headline: 'See what a better workflow looks like',
    description: 'Tell us a little about your team. We will follow up with a focused walkthrough, not a generic sales pitch.',
    submitLabel: 'Request a demo', successMessage: 'Thanks for reaching out. Our team will be in touch soon.',
    tags: ['demo-request', 'website'], accent: '#176d68', layout: 'card',
    fields: [
      { key: 'email', label: 'Work email', type: 'email', required: true, placeholder: 'you@company.com', locked: true },
      { key: 'first_name', label: 'First name', type: 'text', required: true, placeholder: 'Alex' },
      { key: 'company', label: 'Company', type: 'text', required: true, placeholder: 'Your organization' },
      { key: 'role', label: 'Your role', type: 'select', required: false, placeholder: 'Choose a role', options: ['Founder or owner', 'Marketing', 'Sales', 'Operations', 'Other'] },
      { key: 'goals', label: 'What would you like to improve?', type: 'textarea', required: false, placeholder: 'Share one goal or challenge' }
    ]
  },
  {
    key: 'webinar-registration', category: 'Events', name: 'Webinar · registration',
    headline: 'Save your seat for the live session',
    description: 'Register for a practical session with time for questions. Add the confirmed date, time, and event details before turning this form on.',
    submitLabel: 'Save my seat', successMessage: 'You are registered. We will send the event details to your inbox.',
    tags: ['webinar', 'event-registration'], accent: '#7652c9', layout: 'card',
    fields: [
      { key: 'email', label: 'Email address', type: 'email', required: true, placeholder: 'you@company.com', locked: true },
      { key: 'first_name', label: 'First name', type: 'text', required: true, placeholder: 'Alex' },
      { key: 'company', label: 'Company', type: 'text', required: false, placeholder: 'Your organization' },
      { key: 'question', label: 'Question for the speaker', type: 'textarea', required: false, placeholder: 'What would you like us to cover?' }
    ]
  },
  {
    key: 'customer-feedback', category: 'Customer care', name: 'Customer feedback · check-in',
    headline: 'Help us make this better',
    description: 'A quick check-in for customers. Your honest feedback helps us focus on what matters most.',
    submitLabel: 'Send feedback', successMessage: 'Thank you for sharing your perspective. We really appreciate it.',
    tags: ['customer-feedback'], accent: '#bd6b33', layout: 'card',
    fields: [
      { key: 'email', label: 'Email address', type: 'email', required: true, placeholder: 'you@company.com', locked: true },
      { key: 'rating', label: 'How is your experience so far?', type: 'select', required: true, placeholder: 'Choose a rating', options: ['Excellent', 'Good', 'It is okay', 'Needs improvement'] },
      { key: 'what_works', label: 'What is working well?', type: 'textarea', required: false, placeholder: 'Tell us what you value most' },
      { key: 'improvement', label: 'What could be better?', type: 'textarea', required: false, placeholder: 'One suggestion is plenty' }
    ]
  },
  {
    key: 'early-access-waitlist', category: 'Product launch', name: 'Early access · waitlist',
    headline: 'Be first to try what is next',
    description: 'Join the early-access list for product updates and an invitation when places become available.',
    submitLabel: 'Join the waitlist', successMessage: 'You are on the early-access list. We will be in touch when there is news.',
    tags: ['early-access', 'product-launch'], accent: '#1682a0', layout: 'inline',
    fields: [
      { key: 'email', label: 'Email address', type: 'email', required: true, placeholder: 'you@company.com', locked: true },
      { key: 'first_name', label: 'First name', type: 'text', required: false, placeholder: 'Alex' },
      { key: 'company_size', label: 'Team size', type: 'select', required: false, placeholder: 'Choose team size', options: ['Just me', '2–10', '11–50', '51–200', '201+'] },
      { key: 'use_case', label: 'What would you use it for?', type: 'textarea', required: false, placeholder: 'A sentence about your use case' },
      { key: 'product_updates_consent', label: 'I agree to be contacted about early access and product updates.', type: 'checkbox', required: true }
    ]
  }
];

const starterAutomations = [
  {
    key: 'subscriber-welcome-series', name: 'New subscriber · welcome series',
    description: 'A draft welcome journey for new opt-ins. Select the matching signup form and a verified sender before activation.',
    trigger: 'form_submitted', first: 'welcome-subscriber', second: 'trial-first-win',
    steps: [{ type: 'email', template: 'welcome-subscriber' }, { type: 'delay', delayMinutes: 1440 }, { type: 'email', template: 'trial-first-win' }]
  },
  {
    key: 'trial-onboarding', name: 'Trial · first-week onboarding',
    description: 'A short, helpful setup sequence for trial accounts. Customize the trigger tag and sender for your workspace.',
    trigger: 'tag_added', triggerTag: 'trial-started', first: 'trial-first-win', second: 'customer-check-in',
    steps: [{ type: 'email', template: 'trial-first-win' }, { type: 'delay', delayMinutes: 1440 }, { type: 'email', template: 'customer-check-in' }]
  },
  {
    key: 'webinar-registration', name: 'Webinar · registrant follow-up',
    description: 'A registration follow-up with room for event-specific timing and links. Attach the correct signup form before activation.',
    trigger: 'form_submitted', first: 'webinar-reminder', second: 'event-follow-up',
    steps: [{ type: 'email', template: 'webinar-reminder' }, { type: 'delay', delayMinutes: 1440 }, { type: 'email', template: 'event-follow-up' }]
  },
  {
    key: 'attendee-resources', name: 'Event attendee · resources',
    description: 'Share the promised recap after an attendance tag is applied, then stop follow-up when the contact replies.',
    trigger: 'tag_added', triggerTag: 'attended-event', first: 'event-follow-up', second: 'feedback-request',
    steps: [{ type: 'email', template: 'event-follow-up' }, { type: 'delay', delayMinutes: 4320 }, { type: 'condition', condition: 'If replied → stop' }, { type: 'email', template: 'feedback-request' }]
  },
  {
    key: 'customer-kickoff', name: 'New customer · kickoff',
    description: 'A calm onboarding journey for new customers. Choose the appropriate customer list and verified sender before activation.',
    trigger: 'contact_added', first: 'post-purchase', second: 'customer-check-in',
    steps: [{ type: 'email', template: 'post-purchase' }, { type: 'delay', delayMinutes: 2880 }, { type: 'email', template: 'customer-check-in' }]
  },
  {
    key: 'renewal-prep', name: 'Renewal · preparation',
    description: 'Start a personalized value review from a renewal tag and leave time for a genuine conversation.',
    trigger: 'tag_added', triggerTag: 'renewal-review', first: 'renewal-review', second: 'customer-check-in',
    steps: [{ type: 'email', template: 'renewal-review' }, { type: 'delay', delayMinutes: 10080 }, { type: 'email', template: 'customer-check-in' }]
  },
  {
    key: 'subscriber-reengagement', name: 'Subscriber · re-engagement',
    description: 'A respectful preference check for an explicitly selected inactive segment; do not enroll contacts without appropriate consent.',
    trigger: 'tag_added', triggerTag: 'reengagement-review', first: 'reengagement', second: 'feedback-request',
    steps: [{ type: 'email', template: 'reengagement' }, { type: 'delay', delayMinutes: 7200 }, { type: 'condition', condition: 'If replied → stop' }, { type: 'email', template: 'feedback-request' }]
  }
];

const makeBlocks = entry => [
  { type: 'heading', content: entry.heading, size: 26, weight: 700, color: '#17365f', lineHeight: 1.25, padding: 0 },
  { type: 'text', content: 'Hi {{first_name|there}},', size: 15, color: '#334a67', lineHeight: 1.6 },
  { type: 'text', content: entry.intro, size: 15, color: '#334a67', lineHeight: 1.6 },
  { type: 'text', content: entry.body, size: 15, color: '#334a67', lineHeight: 1.6 },
  { type: 'button', content: entry.cta, href: 'https://example.com', background: '#1f4e94', color: '#ffffff', radius: 8, padding: 12, weight: 600, align: 'left' },
  { type: 'text', content: 'Questions? Reply to this message and our team will help.', size: 14, color: '#526984', lineHeight: 1.6 },
  { type: 'divider', borderColor: '#e3eaf4', borderWidth: 1, padding: 16 },
  { type: 'address', content: 'Physical address: add your business mailing address here.', color: '#7b8ca5', size: 12, align: 'center' },
  { type: 'unsubscribe', content: 'Unsubscribe', color: '#7b8ca5', size: 12, align: 'center' }
];

const idFor = (workspaceHash, type, key) => `starter-${workspaceHash}-${type}-${key}`;

/**
 * Adds practical, editable workspace examples once. Deterministic ids and atomic
 * insert-if-absent writes make retries safe; a completed marker prevents deleted or
 * customized starter content from being recreated or overwritten on later sign-ins.
 */
export async function ensureWorkspaceDefaultContent({ organizationId }) {
  if (typeof organizationId !== 'string' || !organizationId.trim()) throw new TypeError('organizationId is required');
  const workspaceHash = stableHash('workspace-default-content', organizationId).slice(0, 18);
  const markerId = `workspace-default-content:${workspaceHash}:v${CONTENT_VERSION}`;
  // Keep forms on their own marker. Releasing new form examples must not make an old
  // workspace re-create a template, campaign, or automation the user deliberately deleted.
  const formMarkerId = `workspace-default-forms:${workspaceHash}`;
  const markers = collection('workspace_default_seeds');
  const [marker, formMarker] = await Promise.all([
    markers.findOne({ _id: markerId }), markers.findOne({ _id: formMarkerId })
  ]);
  const seedLibrary = marker?.status !== 'complete';
  // The v2 unified marker was written after the five Forms starters were introduced.
  // Treat it as a completed Forms seed too, so splitting the markers does not restore
  // a starter someone intentionally deleted. Older workspaces still receive Forms as
  // part of the v1-to-v2 onboarding upgrade.
  const hasLegacyUnifiedCompletion = marker?.status === 'complete';
  const previousFormVersion = formMarker?.status === 'complete'
    ? Number(formMarker.version) || 0
    : hasLegacyUnifiedCompletion ? FORM_CONTENT_VERSION : 0;
  const formsToSeed = formMarker?.status === 'complete'
    ? starterForms.filter(entry => (entry.contentVersion || 1) > previousFormVersion
      && (entry.contentVersion || 1) <= FORM_CONTENT_VERSION)
    : hasLegacyUnifiedCompletion ? []
      : starterForms.filter(entry => (entry.contentVersion || 1) <= FORM_CONTENT_VERSION);
  if (!seedLibrary && formMarker?.status === 'complete'
      && previousFormVersion >= FORM_CONTENT_VERSION && !formsToSeed.length) {
    return { seeded: false, version: CONTENT_VERSION, formsVersion: FORM_CONTENT_VERSION };
  }

  const now = new Date().toISOString();
  if (seedLibrary) {
    const templateIds = new Map();
    for (const entry of starterTemplates) {
      const _id = idFor(workspaceHash, 'template', entry.key);
      templateIds.set(entry.key, _id);
      const styles = { ...DEFAULT_EMAIL_STYLES, background: '#f3f6fb', width: 640, padding: 28, radius: 12 };
      const blocks = makeBlocks(entry);
      const parsed = templateSchema.parse({ name: entry.name, subject: entry.subject, blocks, styles, mode: 'blocks' });
      await collection('templates').insertIfAbsent({ _id, organizationId, ...parsed,
        category: entry.category, blocks: parsed.blocks, html: blocksToHtml(parsed.blocks, parsed.styles),
        status: 'draft', version: 1, starterContent: true, starterCategory: entry.category, createdAt: now, updatedAt: now });
    }

    for (const entry of starterCampaigns) {
      const _id = idFor(workspaceHash, 'campaign', entry.key);
      const parsed = campaignSchema.parse({ name: entry.name, description: entry.description, stream: 'marketing',
        sendMode: 'human', gapSeconds: 60, listIds: [], templateId: templateIds.get(entry.template), accountPool: [],
        rotation: 'round_robin', sendPolicy: { minDelaySec: 45, maxDelaySec: 90, jitterPct: 20,
          activeHours: { start: 9, end: 18 }, timezone: 'UTC', dailyCap: 50, weeklyCap: 250,
          weekend: false, pauseOnReply: true, warmup: false } });
      await collection('campaigns').insertIfAbsent({ _id, organizationId, ...parsed, status: 'draft',
        starterContent: true, starterCategory: 'Lifecycle',
        stats: { queued: 0, sent: 0, delivered: 0, bounced: 0, replied: 0, opened: 0, clicked: 0 }, createdAt: now, updatedAt: now });
    }

    for (const entry of starterAutomations) {
      const _id = idFor(workspaceHash, 'automation', entry.key);
      const input = sequenceSchema.parse({ name: entry.name, description: entry.description, trigger: entry.trigger,
        ...(entry.triggerTag ? { triggerTag: entry.triggerTag } : {}), status: 'draft',
        steps: entry.steps.map(step => ({ type: step.type,
          ...(step.template ? { templateId: templateIds.get(step.template) } : {}),
          ...(step.delayMinutes ? { delayMinutes: step.delayMinutes } : {}),
          ...(step.condition ? { condition: step.condition } : {}) })) });
      await collection('sequences').insertIfAbsent({ _id, organizationId, ...input, status: 'draft',
        executionEnabled: false, executionReviewRequired: false, starterContent: true,
        starterCategory: 'Lifecycle', createdAt: now, updatedAt: now });
    }

    await markers.insertIfAbsent({ _id: markerId, organizationId, status: 'complete', version: CONTENT_VERSION,
      counts: { campaigns: starterCampaigns.length, templates: starterTemplates.length, automations: starterAutomations.length },
      createdAt: now, completedAt: new Date().toISOString() });
  }

  for (const entry of formsToSeed) {
    const _id = idFor(workspaceHash, 'form', entry.key);
    const slug = idFor(workspaceHash, 'hosted-form', entry.key).toLowerCase();
    await collection('forms').insertIfAbsent({
      _id, organizationId, name: entry.name, slug, status: 'paused',
      headline: entry.headline, description: entry.description, submitLabel: entry.submitLabel,
      successMessage: entry.successMessage, redirectUrl: '', fields: entry.fields,
      listId: null, automationId: null, tags: entry.tags, doubleOptIn: false,
      appearance: { accent: entry.accent, layout: entry.layout }, views: 0,
      starterContent: true, starterCategory: entry.category,
      createdAt: now, updatedAt: now
    });
  }

  if (formMarker?.status !== 'complete' || previousFormVersion < FORM_CONTENT_VERSION || formsToSeed.length) {
    await markers.insertIfAbsent({ _id: formMarkerId, organizationId, status: 'complete', version: FORM_CONTENT_VERSION,
      counts: { forms: starterForms.filter(entry => (entry.contentVersion || 1) <= FORM_CONTENT_VERSION).length },
      createdAt: now, completedAt: new Date().toISOString() });
    await markers.updateOne({ _id: formMarkerId }, { $set: { status: 'complete', version: FORM_CONTENT_VERSION,
      counts: { forms: starterForms.filter(entry => (entry.contentVersion || 1) <= FORM_CONTENT_VERSION).length },
      completedAt: new Date().toISOString() } });
  }

  return { seeded: true, version: CONTENT_VERSION, formsVersion: FORM_CONTENT_VERSION, counts: {
    campaigns: seedLibrary ? starterCampaigns.length : 0,
    templates: seedLibrary ? starterTemplates.length : 0,
    automations: seedLibrary ? starterAutomations.length : 0,
    forms: formsToSeed.length
  } };
}
