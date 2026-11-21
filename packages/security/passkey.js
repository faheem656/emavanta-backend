/** WebAuthn-style software passkey verification (P-256 / ES256) for MFA and passwordless sign-in. */
import { randomBytes, createPublicKey, createVerify } from 'node:crypto';

export const newChallenge = () => randomBytes(32).toString('base64url');

/** WebCrypto ECDSA signatures are raw P1363 (r||s); Node expects DER. */
export const rawSignatureToDer = raw => {
  const b = Buffer.from(raw);
  if (b.length !== 64) return b; // already DER or invalid; verify() will reject the latter
  const toInt = chunk => {
    let i = 0;
    while (i < chunk.length - 1 && chunk[i] === 0) i++;
    let bytes = chunk.subarray(i);
    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const seq = Buffer.concat([toInt(b.subarray(0, 32)), toInt(b.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
};

export const verifyPasskeySignature = ({ jwk, challenge, signature }) => {
  try {
    const key = createPublicKey({ key: typeof jwk === 'string' ? JSON.parse(jwk) : jwk, format: 'jwk' });
    const verify = createVerify('sha256');
    verify.update(String(challenge));
    return verify.verify(key, rawSignatureToDer(signature));
  } catch { return false; }
};

export const passkeyRegistrationOptions = (email, challenge) => ({
  challenge,
  rp: { name: 'Emavanta' },
  user: { id: Buffer.from(email).toString('base64url'), name: email, displayName: email },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  authenticatorSelection: { userVerification: 'preferred' },
  note: 'Software passkey flow for this self-hosted build; hardware FIDO2 attestation can be added with a CBOR parser.'
});
