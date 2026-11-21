import jwt from 'jsonwebtoken';
const secret = () => process.env.JWT_SECRET || 'demo-jwt-secret-change-in-production-32';
export const signSession = payload => jwt.sign(payload, secret(), { expiresIn: '7d', issuer: 'emavanta' });
export const verifySession = token => {
  try { return jwt.verify(token, secret(), { issuer: 'emavanta' }); }
  catch { return null; }
};
export const signInvite = payload => jwt.sign(payload, secret(), { expiresIn: '7d', issuer: 'emavanta-invite' });
export const verifyInvite = token => {
  try { return jwt.verify(token, secret(), { issuer: 'emavanta-invite' }); }
  catch { return null; }
};
