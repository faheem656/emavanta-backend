import { z } from 'zod';
export const email = z.string().email().max(254).transform(v => v.toLowerCase().trim());
export const password = z.string().min(12).max(128);
export const registerSchema = z.object({ email, password, name: z.string().min(2).max(80), organization: z.string().min(2).max(80) });
// Sign-in must not lecture about password rules: any non-empty value goes to the
// verifier, which answers with one honest "email or password is not correct".
export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const inviteSchema = z.object({ email, role: z.enum(['admin','member','viewer','billing','client']), workspaceId: z.string().optional() });
export const contactSchema = z.object({
  email, firstName: z.string().max(80).optional(), lastName: z.string().max(80).optional(),
  company: z.string().max(120).optional(), customFields: z.record(z.string()).default({}),
  phone: z.string().max(40).optional(), city: z.string().max(80).optional(),
  country: z.string().max(80).optional(), title: z.string().max(120).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  listIds: z.array(z.string()).default([])
});
export const sendPolicySchema = z.object({
  minDelaySec: z.number().int().min(5).max(600).default(45),
  maxDelaySec: z.number().int().min(10).max(900).default(90),
  jitterPct: z.number().min(0).max(40).default(20),
  activeHours: z.object({ start: z.number().int().min(0).max(23).default(9), end: z.number().int().min(1).max(24).default(18) }).default({}),
  timezone: z.string().default('UTC').refine(value => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, { message: 'timezone must be a valid IANA timezone' }),
  schedule: z.object({
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'startTime must use HH:mm'),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'endTime must use HH:mm'),
    daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1)
      .refine(days => new Set(days).size === days.length, {
        message: 'daysOfWeek must not contain duplicates'
      })
  }).optional().refine(schedule => {
    if (!schedule) return true;
    const toMinutes = value => {
      const [hours, minutes] = value.split(':').map(Number);
      return hours * 60 + minutes;
    };
    return toMinutes(schedule.startTime) < toMinutes(schedule.endTime);
  }, { message: 'schedule endTime must be later than startTime' }),
  dailyCap: z.number().int().min(1).max(2000).default(50),
  weeklyCap: z.number().int().min(1).max(14000).default(250),
  weekend: z.boolean().default(false),
  pauseOnReply: z.boolean().default(true),
  warmup: z.boolean().default(false)
}).refine(v => v.maxDelaySec >= v.minDelaySec, { message: 'maxDelaySec must be >= minDelaySec' });
export const sequenceSchema = z.object({ name: z.string().min(2).max(120),
  description: z.string().max(280).optional(),
  trigger: z.enum(['manual','contact_added','form_submitted','tag_added','api']).optional(),
  listId: z.string().max(120).optional(), triggerTag: z.string().trim().min(1).max(80).optional(),
  accountId: z.string().max(120).optional(),
  status: z.enum(['draft','paused','active']).optional(),
  formId: z.string().max(80).optional(),
  steps: z.array(z.object({
    type: z.enum(['email','delay','condition']), templateId: z.string().max(120).optional(), accountId: z.string().max(120).optional(),
    delayMinutes: z.number().int().min(0).max(525600).optional(), condition: z.string().trim().max(120).optional(),
    subject: z.string().max(200).optional()
  })).min(1).max(30) });
export const templateSchema = z.object({
  name: z.string().min(2).max(120), subject: z.string().min(1).max(200),
  blocks: z.array(z.object({ type: z.string(), content: z.string().default(''),
    href: z.string().max(2000).optional(), alt: z.string().max(200).optional(),
    align: z.enum(['left','center','right']).optional(), color: z.string().max(40).optional(),
    size: z.union([z.string(), z.number()]).optional().transform(v => (v === undefined ? undefined : String(v))),
    height: z.union([z.number(), z.string()]).optional().transform(v => (v === undefined ? undefined : Number(v))),
    background: z.string().max(40).optional(),
    padding: z.union([z.number(), z.string()]).optional().transform(v => (v === undefined || v === '' ? undefined : Number(v))),
    source: z.string().max(80).optional(),
    // Elementor-style styling the visual editor exposes
    weight: z.union([z.string(), z.number()]).optional().transform(v => (v === undefined ? undefined : String(v))),
    lineHeight: z.union([z.string(), z.number()]).optional().transform(v => (v === undefined ? undefined : String(v))),
    letterSpacing: z.union([z.string(), z.number()]).optional().transform(v => (v === undefined ? undefined : String(v))),
    radius: z.union([z.number(), z.string()]).optional().transform(v => (v === undefined || v === '' ? undefined : Number(v))),
    borderColor: z.string().max(40).optional(),
    borderWidth: z.union([z.number(), z.string()]).optional().transform(v => (v === undefined || v === '' ? undefined : Number(v))),
    width: z.union([z.number(), z.string()]).optional().transform(v => (v === undefined || v === '' ? undefined : Number(v))),
    fontFamily: z.string().max(120).optional(),
    link: z.string().max(2000).optional(),
    linkColor: z.string().max(40).optional(), underline: z.boolean().optional(),
    gap: z.union([z.number(), z.string()]).optional().transform(v => (v === undefined || v === '' ? undefined : Number(v))),
    opacity: z.union([z.number(), z.string()]).optional().transform(v => (v === undefined || v === '' ? undefined : Number(v)))
  })).min(1),
  // Page-level styling shared with the sent email
  styles: z.object({ background: z.string().max(30).optional(), width: z.number().optional(),
    fontFamily: z.string().max(80).optional(), padding: z.number().optional(),
    radius: z.number().optional(), subjectColor: z.string().max(30).optional() }).optional(),
  html: z.string().optional(), mode: z.enum(['blocks','code']).default('blocks')
});
export const campaignSchema = z.object({
  name: z.string().min(2).max(120), description: z.string().max(280).optional(),
  stream: z.enum(['transactional','marketing','outreach']),
  // 'blast' = everyone as fast as the mailboxes allow, 'human' = one at a time with a
  // natural pause, which is what keeps cold outreach from looking like a machine.
  sendMode: z.enum(['blast','human']).default('human'),
  gapSeconds: z.number().int().min(5).max(3600).optional(),
  // Drafts may be incomplete during setup. Launch performs strict audience and sender checks.
  listIds: z.array(z.string()).default([]), templateId: z.string(),
  accountPool: z.array(z.string()).default([]),
  rotation: z.enum(['round_robin','weighted','least_used','random_jitter','sticky_by_contact']).default('round_robin'),
  sendPolicy: sendPolicySchema.optional(),
  sequenceSteps: z.array(z.object({
    type: z.enum(['email','delay','condition']),
    templateId: z.string().optional(),
    accountId: z.string().optional(),
    days: z.number().int().min(1).max(90).optional(),
    condition: z.string().max(160).optional()
  })).max(25).optional(),
  startAt: z.string().datetime().optional()
});
export const campaignDraftSchema = z.object({
  state: z.record(z.any()),
  campaignId: z.string().optional()
});
export const apiKeySchema = z.object({ name: z.string().min(2), scopes: z.array(z.string()).min(1), expiresInDays: z.number().int().min(1).max(365).default(90), ipAllowlist: z.array(z.string()).default([]) });
export const addonSchema = z.object({ code: z.string().min(2), quantity: z.number().int().min(1).max(20).default(1) });

