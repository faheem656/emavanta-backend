import { randomBytes, createHash } from 'node:crypto';
export const createOAuthState = () => {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { state, verifier, challenge };
};
export const googleAuthUrl = (clientId, redirectUri, { state, challenge }) => {
  const p = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',
    state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
};
export const microsoftAuthUrl = (clientId, redirectUri, { state, challenge }) => {
  const p = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: 'offline_access openid profile email Mail.Send Mail.Read',
    state, code_challenge: challenge, code_challenge_method: 'S256'
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${p}`;
};
export const exchangeCode = async (provider, { code, clientId, clientSecret, redirectUri, verifier }) => {
  const url = provider === 'google' ? 'https://oauth2.googleapis.com/token' : `https://login.microsoftonline.com/common/oauth2/v2.0/token`;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri,
    grant_type: 'authorization_code', code_verifier: verifier });
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`OAuth exchange failed: ${res.status}`);
  return res.json();
};
