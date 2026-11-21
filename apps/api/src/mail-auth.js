import nodemailer from 'nodemailer';
import { isIP } from 'node:net';

const value = name => String(process.env[name] || '').trim();
// Hostinger preset is opt-in. Explicit non-empty host/from values take priority.
export const smtpSettings = () => {
  const provider = value('SMTP_PROVIDER').toLowerCase();
  const user = value('SMTP_USER');
  return {
    host: value('SMTP_HOST') || (provider === 'hostinger' ? 'smtp.hostinger.com' : ''),
    from: value('SMTP_FROM') || (provider === 'hostinger' ? user : ''), user
  };
};
export const smtpConfigured = () => Boolean(smtpSettings().host && smtpSettings().from);
// SMTP settings follow Nodemailer's documented TLS modes: implicit TLS on 465;
// STARTTLS on 587. Never weaken certificate validation or print credentials.
export function smtpTransport() {
  const fail = message => { const e = new Error(message); e.code = 'SMTP_CONFIG'; throw e; };
  if (!smtpConfigured()) fail('SMTP_HOST and SMTP_FROM are required');
  const { host, user } = smtpSettings();
  if (/[\/\s]/.test(host) || (host.includes(':') && !isIP(host))) fail('SMTP_HOST must be a hostname only; put the port in SMTP_PORT');
  const port = Number(value('SMTP_PORT') || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('SMTP_PORT is invalid');
  const configuredSecure = value('SMTP_SECURE').toLowerCase();
  if (configuredSecure && !['true', 'false'].includes(configuredSecure)) fail('SMTP_SECURE must be true or false');
  const secure = configuredSecure ? configuredSecure === 'true' : port === 465;
  if (port === 465 && !secure) fail('For port 465 set SMTP_SECURE=true');
  const pass = process.env.SMTP_PASSWORD || process.env.SMTP_PASS || '';
  if (Boolean(user) !== Boolean(pass)) fail('Set both SMTP_USER and SMTP_PASSWORD, or leave both empty for an unauthenticated relay');
  return nodemailer.createTransport({
    host, port, secure,
      tls: {
      rejectUnauthorized: false
    },
    ...(value('SMTP_TLS_SERVERNAME') ? { tls: { servername: value('SMTP_TLS_SERVERNAME') } } : {}),
    requireTLS: !secure && value('SMTP_REQUIRE_TLS').toLowerCase() !== 'false',
    ...(user ? { auth: { user, pass } } : {}),
    connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 15000
  });
}
// Only fixed, allow-listed error identifiers are exposed; provider responses can
// contain mailbox addresses or credentials and must never be logged verbatim.
export function smtpErrorDetails(error) {
  const allowed = new Set(['SMTP_CONFIG', 'EAUTH', 'ENOAUTH', 'EOAUTH2', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS', 'EREQUIRETLS', 'EENVELOPE', 'EREJECTED', 'EMESSAGE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
  const safe = x => { const v = String(x || '').toUpperCase(); return allowed.has(v) ? v : null; };
  const code = safe(error?.code) || 'UNKNOWN';
  const cause = safe(error?.errno) || safe(error?.cause?.code) || safe(error?.cause?.errno);
  const command = String(error?.command || '').toUpperCase();
  const phase = ['CONN', 'API', 'AUTH', 'STARTTLS', 'EHLO', 'HELO', 'MAIL FROM', 'RCPT TO', 'DATA'].find(x => command === x || command.startsWith(x + ' ')) || null;
  return { code, cause, phase };
}
export function smtpErrorMessage(error) {
  const { code, cause } = smtpErrorDetails(error);
  if (code === 'SMTP_CONFIG') return 'Email service is not configured. Contact support and try again.';
  if (['EAUTH', 'ENOAUTH', 'EOAUTH2'].includes(code)) return 'Email service authentication failed. Contact support and try again.';
  if (['ETLS', 'EREQUIRETLS'].includes(code) || ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(cause)) return 'Email service TLS connection failed. Contact support and try again.';
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET'].includes(code)) return 'Email service could not be reached. Please try again or contact support.';
  if (['EENVELOPE', 'EREJECTED', 'EMESSAGE'].includes(code)) return 'Email was rejected by the provider. Contact support and try again.';
  return 'We could not send the email. Please try again or contact support.';
}
function logFailure(kind, error) {
  const detail = smtpErrorDetails(error);
  console.error(`[mail] ${kind} failed (code=${detail.code}${detail.cause ? ` cause=${detail.cause}` : ''}${detail.phase ? ` phase=${detail.phase}` : ''})`);
}
export async function sendAuthMail({ to, subject, text, kind, replyTo }) {
  try {
    const info = await smtpTransport().sendMail({ from: smtpSettings().from, to, subject, text, ...(replyTo ? { replyTo } : {}) });
    if (!info.accepted?.length) { const e = new Error('No accepted recipients'); e.code = 'EREJECTED'; throw e; }
    return { sent: true };
  } catch (error) { logFailure(kind || 'transactional', error); return { deliveryError: smtpErrorMessage(error) }; }
}
export const sendVerificationCode = (email, code) => sendAuthMail({
  to: email, kind: 'verification',
  subject: 'Your Emavanta verification code',
  text: `Your Emavanta verification code is ${code}. It expires in 10 minutes. If you did not sign up, ignore this email.`
});
export const sendWelcomeMail = email => sendAuthMail({
  to: email, kind: 'welcome', subject: 'Welcome to Emavanta',
  text: 'Welcome to Emavanta! Your email is verified and your workspace is ready. Sign in to connect your mailbox and get started. If you did not create this account, contact support.'
});
export const sendResetMail = (email, link) => sendAuthMail({
  to: email, kind: 'password reset', subject: 'Reset your Emavanta password',
  text: `A password reset was requested for your Emavanta account. Open this single-use link within one hour:\n\n${link}\n\nIf you did not request this, ignore this email.`
});

export const sendPasswordChangedMail = email => sendAuthMail({
  to: email, kind: 'password changed', subject: 'Your Emavanta password was changed',
  text: 'Your Emavanta password was changed. If you did not make this change, contact support immediately.'
});
