import { extractTokens, DEFAULT_FALLBACKS } from './personalization.js';
import { sanitizeHtml } from './template.js';

const SPAM_WORDS = ['free money','guaranteed','act now','limited time offer','click here','buy now','100% free','urgent'];

export const preflight = ({ subject, html, tokens = {}, unsubscribeUrl }) => {
  const issues = [];
  const body = sanitizeHtml(html || '');
  const allTokens = new Set([...extractTokens(subject), ...extractTokens(html)]);
  for (const token of allTokens) {
    if (!tokens[token] && DEFAULT_FALLBACKS[token] === undefined) issues.push({ level: 'warning', code: 'NO_FALLBACK', token });
  }
  if (!unsubscribeUrl && !/unsubscribe/i.test(body)) issues.push({ level: 'error', code: 'MISSING_UNSUBSCRIBE' });
  if (!/physical address|address:/i.test(body)) issues.push({ level: 'warning', code: 'MISSING_ADDRESS' });
  const lower = `${subject} ${body}`.toLowerCase();
  for (const w of SPAM_WORDS) if (lower.includes(w)) issues.push({ level: 'warning', code: 'SPAM_WORD', word: w });
  if (Buffer.byteLength(body, 'utf8') > 102_400) issues.push({ level: 'warning', code: 'GMAIL_CLIP', size: Buffer.byteLength(body, 'utf8') });
  if (/href="https?:\/\/(127\.|localhost|10\.|192\.168\.)/i.test(body)) issues.push({ level: 'error', code: 'PRIVATE_LINK' });
  const blocking = issues.some(i => i.level === 'error');
  return { ok: !blocking, issues, tokens: [...allTokens], bytes: Buffer.byteLength(body, 'utf8') };
};
