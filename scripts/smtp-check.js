import { loadEnv } from '../packages/shared/env.js';
import { smtpTransport, smtpErrorMessage, smtpSettings, smtpErrorDetails } from '../apps/api/src/mail-auth.js';
const env = loadEnv();
const to = process.argv[2];
const effective = smtpSettings();
const source = key => env.sources?.[key] || 'not set';
console.log(`Environment files: ${env.files.join(', ') || '(none)'}`);
console.log(`SMTP_HOST: ${effective.host ? 'configured' : 'MISSING'}; SMTP_FROM: ${effective.from ? 'configured' : 'MISSING'}; SMTP_USER: ${process.env.SMTP_USER ? 'configured' : 'not set'}; SMTP_PASSWORD: ${process.env.SMTP_PASSWORD || process.env.SMTP_PASS ? 'configured' : 'not set'}`);
console.log(`Provider preset: ${process.env.SMTP_PROVIDER || '(none)'}`);
console.log(`SMTP_PORT: ${process.env.SMTP_PORT || '587'}; SMTP_SECURE: ${process.env.SMTP_SECURE || '(automatic)'}; SMTP_REQUIRE_TLS: ${process.env.SMTP_REQUIRE_TLS || 'true'}`);
console.log(`Effective sources: SMTP_HOST=${source('SMTP_HOST')}; SMTP_USER=${source('SMTP_USER')}; SMTP_PASSWORD=${source(env.sources?.SMTP_PASSWORD ? 'SMTP_PASSWORD' : 'SMTP_PASS')}; SMTP_FROM=${source('SMTP_FROM')}.`);
let transport;
try {
  transport = smtpTransport();
  await transport.verify();
  console.log('SMTP connection and authentication succeeded. This does not guarantee inbox delivery.');
  if (to) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('Supply a valid recipient email.');
    const info = await transport.sendMail({ from: effective.from, to, subject: 'Emavanta SMTP test', text: 'This is an SMTP test message from Emavanta.' });
    if (!info.accepted?.length) throw new Error('The SMTP server did not accept the recipient.');
    console.log('Test message accepted by SMTP. Check the inbox and spam folder.');
  } else console.log('To send a test message to your own inbox: npm run smtp:check -- you@example.com');
} catch (e) {
  const safe = smtpErrorDetails(e);
  console.error(`SMTP check failed: ${smtpErrorMessage(e)} (${safe.code})`);
  console.error(`Safe diagnostic: code=${safe.code}${safe.cause ? `; cause=${safe.cause}` : ''}${safe.phase ? `; phase=${safe.phase}` : ''}`);
  if (['ENOTFOUND','EAI_AGAIN'].includes(safe.code) || ['ENOTFOUND','EAI_AGAIN'].includes(safe.cause)) console.error('DNS lookup failed: check SMTP_HOST and server DNS.');
  else if (safe.cause === 'ECONNREFUSED') console.error('The connection was refused: check the SMTP host, port and firewall.');
  else if (safe.code === 'SMTP_CONFIG') console.error(`Configuration: ${e.message}`);
  else if (['EAUTH','ENOAUTH','EOAUTH2'].includes(e.code)) console.error('Check SMTP_USER, SMTP_PASSWORD/app password and provider authentication policy.');
  else if (['ETLS','EREQUIRETLS'].includes(e.code)) console.error('Check the host, TLS certificate and port: 465 uses SMTP_SECURE=true; 587 uses false with STARTTLS.');
  else if (['EENVELOPE','EREJECTED','EMESSAGE'].includes(e.code)) console.error('The provider rejected the sender or recipient. Check SMTP_FROM, sender verification and provider policy.');
  else console.error('Check the hostname, outbound port, firewall/VPN, DNS and provider availability.');
  console.error('Restart the app after changing .env. Never share passwords, provider URLs, private keys or OTP codes.');
  process.exitCode = 1;
} finally { transport?.close(); }
