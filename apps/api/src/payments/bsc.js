// Receipt verifier used by the experimental checkout. The RPC operator must be trusted.
// No private keys are required.
export const BSC_CHAIN_ID = 56n;
export const BSC_USDT = '0x55d398326f99059ff775485246999027b3197955';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const addressRE = /^0x[0-9a-f]{40}$/i;
const hashRE = /^0x[0-9a-f]{64}$/i;
const quantityRE = /^0x[0-9a-f]+$/i;
const qty = v => { if (!quantityRE.test(String(v || ''))) throw new Error('Malformed RPC response'); return BigInt(v); };
export const validAddress = value => addressRE.test(String(value || '')) && !/^0x0{40}$/i.test(value);

export function bscClient(url, fetchImpl = globalThis.fetch) {
  const parsed = new URL(String(url || ''));
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid RPC URL');
  // Plain HTTP is for localhost tests only; credentials are never printed.
  if (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) throw new Error('RPC must use HTTPS');
  let id = 0;
  return async (method, params = []) => {
    const requestId = ++id;
    const res = await fetchImpl(parsed.toString(), { method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0', id:requestId, method, params}), signal:AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('RPC request failed');
    const body = await res.json();
    if (body.error || !Object.hasOwn(body, 'result') || body.id !== requestId) throw new Error('RPC returned an error');
    return body.result;
  };
}
export async function checkBsc(rpc) {
  const chain = qty(await rpc('eth_chainId'));
  if (chain !== BSC_CHAIN_ID) throw new Error('RPC is not BNB Smart Chain mainnet');
  const code = await rpc('eth_getCode', [BSC_USDT, 'latest']);
  if (!/^0x[0-9a-f]+$/i.test(code || '') || /^0x0*$/i.test(code)) throw new Error('USDT contract unavailable');
  const decimals = qty(await rpc('eth_call', [{to:BSC_USDT, data:'0x313ce567'}, 'latest']));
  if (decimals !== 18n) throw new Error('Unexpected USDT token decimals');
  const block = qty(await rpc('eth_blockNumber'));
  return { chainId:56, contract:BSC_USDT, decimals:18, block:block.toString() };
}

// Receipt checking; replay protection and atomic settlement are handled by crypto-service.
export async function verifyUsdtTransfer(rpc, { txHash, recipient, amountUsd, minConfirmations = 20, sender, notBefore, notAfter }) {
  if (!hashRE.test(String(txHash || '')) || !validAddress(recipient)) throw new Error('Invalid transaction hash or address');
  if (sender && !validAddress(sender)) throw new Error('Invalid sender');
  if (!Number.isSafeInteger(amountUsd) || amountUsd <= 0) throw new Error('Invalid amount');
  if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 20 || minConfirmations > 1000) throw new Error('Invalid confirmation threshold');
  if (qty(await rpc('eth_chainId')) !== BSC_CHAIN_ID) throw new Error('Wrong chain');
  const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  if (!receipt || !hashRE.test(receipt.transactionHash || '') || receipt.transactionHash.toLowerCase() !== txHash.toLowerCase() || qty(receipt.status) !== 1n) throw new Error('Transaction not confirmed successfully');
  if (!hashRE.test(receipt.blockHash || '')) throw new Error('Receipt block hash missing');
  const blockNumber = qty(receipt.blockNumber);
  const [head, canonical, transaction] = await Promise.all([rpc('eth_blockNumber'), rpc('eth_getBlockByNumber', [receipt.blockNumber, false]), sender ? rpc('eth_getTransactionByHash', [txHash]) : null]);
  const height = qty(head);
  if (!canonical || !hashRE.test(canonical.hash || '') || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase() || qty(canonical.number) !== blockNumber) throw new Error('Receipt is not in the canonical chain');
  if (height < blockNumber || height - blockNumber + 1n < BigInt(minConfirmations)) throw new Error('Not enough confirmations');
  if (sender && (!transaction || String(transaction.hash || '').toLowerCase() !== txHash.toLowerCase() || String(transaction.from || '').toLowerCase() !== sender.toLowerCase() || String(transaction.to || '').toLowerCase() !== BSC_USDT)) throw new Error('Transaction sender or token contract does not match');
  if (notBefore !== undefined || notAfter !== undefined) {
    const timestamp = qty(canonical.timestamp);
    if ((notBefore !== undefined && timestamp < BigInt(notBefore)) || (notAfter !== undefined && timestamp > BigInt(notAfter))) throw new Error('Transfer is outside the order time window');
  }
  const dest = recipient.toLowerCase().slice(2).padStart(64, '0');
  const units = BigInt(amountUsd) * 10n ** 18n; // USDT quote assumes 1 USDT = 1 USD.
  const matches = (Array.isArray(receipt.logs) ? receipt.logs : []).filter(log => {
    const topics = log.topics || [];
    return String(log.address || '').toLowerCase() === BSC_USDT && topics.length === 3 &&
      String(topics[0]).toLowerCase() === TRANSFER_TOPIC && /^0x[0-9a-f]{64}$/i.test(String(topics[1])) && (!sender || String(topics[1]).toLowerCase() === `0x${sender.toLowerCase().slice(2).padStart(64, '0')}`) &&
      String(topics[2]).toLowerCase() === `0x${dest}` && /^0x[0-9a-f]{64}$/i.test(String(log.data)) && BigInt(log.data) === units && !log.removed;
  });
  if (matches.length !== 1) throw new Error('No unique matching USDT transfer');
  return { txHash:txHash.toLowerCase(), blockNumber:blockNumber.toString(), blockHash:receipt.blockHash.toLowerCase(),
    confirmations:(height-blockNumber+1n).toString(), recipient:recipient.toLowerCase(), amountUsd };
}
