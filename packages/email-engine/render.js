import { renderText } from './personalization.js';
import { blocksToHtml, sanitizeHtml } from './template.js';
import { stableHash } from '../shared/utils.js';
import { signLink } from '../security/links.js';

/** Relative links work in the dashboard and through the Next rewrites; set
 *  TRACKING_BASE_URL (or APP_URL) for absolute links in real email clients. */
const base = () => (process.env.TRACKING_BASE_URL || process.env.APP_URL || '').replace(/\/$/, '');
const trackUrl = path => `${base()}${path}`;

const escapeAttr = value => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Rewrites external links through the click tracker, skipping anchors/mailto/tracking links. */
const trackLinks = (html, tokenForUrl) => String(html || '')
  .replace(/href\s*=\s*(["'])(.*?)\1/gi, (match, quote, raw) => {
    const url = raw.replace(/&amp;/g, '&');
    if (!url || /^(#|mailto:|tel:|\/t\/l\/|\/u\/)/i.test(url)) return match;
    return `href=${quote}${escapeAttr(trackUrl(`/t/l/${tokenForUrl(url)}`))}${quote}`;
  });

export const renderMessage = ({ template, recipient, account, campaign, organizationId, includeEmavantaBrand = false }) => {
  const org = organizationId || campaign.organizationId || campaign.org || 'demo-org';
  const campaignId = campaign._id || campaign.id;
  const recipientId = recipient._id || recipient.id || recipient.email;
  const messageId = stableHash('message', campaignId, recipient.email);
  const common = { org, campaignId, contactId: recipientId, messageId, email: recipient.email,
    sendingAccountId: account._id,
    ...(campaign.automationId ? { automationId: campaign.automationId } : {}),
    ...(campaign.automationEnrollmentId ? { automationEnrollmentId: campaign.automationEnrollmentId } : {}),
    ...(Number.isInteger(campaign.sequenceStepIndex) ? { sequenceStepIndex: campaign.sequenceStepIndex } : {}) };
  const unsubscribeToken = signLink({ ...common, kind: 'u' });
  const openToken = signLink({ ...common, kind: 'o' });
  const unsubscribeUrl = trackUrl(`/u/${unsubscribeToken}`);
  const openUrl = trackUrl(`/t/o/${openToken}.gif`);
  const clickToken = url => signLink({ ...common, kind: 'l', url });

  const htmlRaw = template.mode === 'code' && template.html ? template.html : blocksToHtml(template.blocks, template.styles);
  const ctx = { ...recipient, customFields: recipient.customFields || {},
    sender: { sender_name: account.fromName || account.fromEmail, senderName: account.fromName || account.fromEmail },
    unsubscribe_url: unsubscribeUrl, unsubscribeUrl, unsubscribe: unsubscribeUrl };
  let html = sanitizeHtml(renderText(htmlRaw, ctx));
  html = trackLinks(html, clickToken);
  if (includeEmavantaBrand) {
    const credit = '<p style="font-family:Arial,sans-serif;font-size:11px;color:#777;text-align:center;margin:24px 0 8px">Powered by <a href="https://emavanta.com" style="color:#777">Emavanta</a></p>';
    html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${credit}</body>`) : `${html}${credit}`;
  }
  const pixel = `<img src="${escapeAttr(openUrl)}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0" />`;
  html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${pixel}</body>`) : `${html}${pixel}`;
  const subject = renderText(template.subject, ctx);

  return {
    id: messageId,
    to: recipient.email,
    from: account.fromEmail,
    fromName: account.fromName,
    replyTo: account.replyTo || account.fromEmail,
    subject, html,
    unsubscribeUrl,
    openUrl,
    tracking: { unsubscribeToken, openToken },
    sendingAccountId: account._id,
    templateVersion: template.version || 1,
    campaignId,
    organizationId: org
  };
};
