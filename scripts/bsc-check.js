import { loadEnv } from '../packages/shared/env.js';
import { bscClient, checkBsc, validAddress } from '../apps/api/src/payments/bsc.js';
const env = loadEnv();
console.log(`Environment files: ${env.files.join(', ') || '(none)'}`);
console.log(`Settings sources: wallet=${env.sources?.BSC_USDT_RECEIVING_ADDRESS || 'not set'}; RPC=${env.sources?.BSC_RPC_URL || 'not set'}.`);
const address=String(process.env.BSC_USDT_RECEIVING_ADDRESS || '').trim();
const url=String(process.env.BSC_RPC_URL || '').trim();
console.log(`Receiving address: ${address ? (validAddress(address) ? 'valid format' : 'INVALID') : 'MISSING'}; BSC_RPC_URL: ${url ? 'configured' : 'MISSING'}`);
if (!validAddress(address) || !url) {
  console.error('Configure the public receiving address and a trusted HTTPS BNB Smart Chain RPC. Never put a private key in .env.');
  process.exitCode=1;
} else {
  try {
    const r=await checkBsc(bscClient(url));
    console.log(`RPC chain: BNB Smart Chain mainnet; USDT contract: ${r.contract}; decimals: ${r.decimals}; block: ${r.block}.`);
    console.log('These checks do NOT enable payments or prove replay protection, settlement, wallet ownership, node trust or subscription lifecycle. Do not accept payment yet.');
  } catch {
    console.error('BSC check failed. Verify the RPC is reachable over HTTPS and points to BNB Smart Chain mainnet. Do not share the RPC URL or its credentials.');
    process.exitCode=1;
  }
}
