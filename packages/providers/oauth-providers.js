/** Direct provider API sending with user's OAuth tokens. No passwords stored. */
const refreshIfNeeded = async account => {
  const exp = account.credentials?.expiresAt;
  if (!exp || Date.parse(exp) > Date.now() + 60000) return account.credentials;
  const res = await fetch(account.authMethod === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : 'https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.credentials.refreshToken,
      client_id: process.env[account.authMethod === 'google' ? 'GOOGLE_CLIENT_ID' : 'MICROSOFT_CLIENT_ID'],
      client_secret: process.env[account.authMethod === 'google' ? 'GOOGLE_CLIENT_SECRET' : 'MICROSOFT_CLIENT_SECRET'] })
  });
  if (!res.ok) { const e = new Error('REAUTH_REQUIRED'); e.code = 'REAUTH_REQUIRED'; throw e; }
  return { ...account.credentials, ...(await res.json()) };
};

export const sendViaGoogle = async (account, message) => {
  const tokens = await refreshIfNeeded(account);
  const raw = [
    `From: ${message.from}`, `To: ${message.to}`, `Subject: ${message.subject}`,
    'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8',
    `X-Campaign-Message: ${message.id}`,
    ...(message.unsubscribeUrl ? [`List-Unsubscribe: <${message.unsubscribeUrl}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'] : []),
    '', message.html
  ].join('\r\n');
  const body = Buffer.from(raw).toString('base64url');
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/send`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: body })
  });
  if (!res.ok) throw new Error(`Gmail send failed: ${res.status}`);
  return { providerMessageId: (await res.json()).id, accepted: true };
};

export const sendViaMicrosoft = async (account, message) => {
  const tokens = await refreshIfNeeded(account);
  const payload = {
    subject: message.subject,
    toRecipients: [{ emailAddress: { address: message.to } }],
    body: { contentType: 'html', content: message.html },
    internetMessageHeaders: [{ name: 'X-Campaign-Message', value: message.id }]
  };
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST', headers: { authorization: `Bearer ${tokens.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: payload, saveToSentItems: true })
  });
  if (!res.ok && res.status !== 202) throw new Error(`Graph send failed: ${res.status}`);
  return { providerMessageId: message.id, accepted: true };
};
