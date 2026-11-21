import { verifyMessage } from 'ethers';
import { validAddress, verifyUsdtTransfer } from './bsc.js';

// The checkout persists an unpredictable nonce and atomically claims transaction hashes.
export function paymentProofMessage({ orderId, organizationId, wallet, nonce }) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(String(orderId || '')) || !/^[a-zA-Z0-9-]{1,80}$/.test(String(organizationId || '')) || !validAddress(wallet) || !/^[0-9a-f]{64}$/i.test(String(nonce || ''))) throw new Error('Invalid payment challenge');
  return `Emavanta payment wallet ownership\nOrder: ${orderId}\nWorkspace: ${organizationId}\nWallet: ${wallet.toLowerCase()}\nNonce: ${nonce.toLowerCase()}\nThis signature does not send funds or authorize a transaction.`;
}
export async function verifyPaymentClaim(rpc, { orderId, organizationId, wallet, nonce, signature, txHash, recipient, amountUsd, notBefore, notAfter }) {
  if (!Number.isSafeInteger(notBefore) || !Number.isSafeInteger(notAfter) || notBefore > notAfter) throw new Error('Invalid order time window');
  const message = paymentProofMessage({ orderId, organizationId, wallet, nonce });
  let recovered;
  try { recovered = verifyMessage(message, signature).toLowerCase(); }
  catch { throw new Error('Invalid wallet signature'); }
  if (recovered !== wallet.toLowerCase()) throw new Error('Wallet signature does not match');
  return verifyUsdtTransfer(rpc, { txHash, recipient, amountUsd, sender:wallet,
    notBefore, notAfter, minConfirmations:64 });
}
