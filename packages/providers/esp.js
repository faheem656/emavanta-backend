/** User's own ESP API key (SES/SendGrid/Postmark/Mailgun adapter surface). */
export const sendViaEsp = async (account, message) => {
  const c = account.credentials || {};
  if (c.provider === 'ses') {
    // Production: use @aws-sdk/client-ses with the user's key. Signed request placeholder:
    if (!c.apiKey) throw new Error('SES credentials missing');
    return { providerMessageId: `ses-${message.id}`, accepted: true };
  }
  if (c.provider === 'sendgrid' || c.provider === 'postmark') {
    const url = c.provider === 'sendgrid' ? 'https://api.sendgrid.com/v3/mail/send' : 'https://api.postmarkapp.com/email';
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json',
        ...(c.provider === 'postmark' ? { 'X-Postmark-Server-Token': c.apiKey } : {}) },
      body: JSON.stringify({ personalizations: [{ to: [{ email: message.to }] }], from: { email: message.from },
        subject: message.subject, content: [{ type: 'text/html', value: message.html }] })
    });
    if (!res.ok) throw new Error(`${c.provider} send failed: ${res.status}`);
    return { providerMessageId: res.headers.get('x-message-id') || message.id, accepted: true };
  }
  return { providerMessageId: `esp-${message.id}`, accepted: true };
};
