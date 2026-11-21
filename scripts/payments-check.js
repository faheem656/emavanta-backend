import '../apps/api/src/env.js';
import { connectDB, disconnectDB, dbInfo, nativeDatabase } from '../packages/database/store.js';
import { validAddress } from '../apps/api/src/payments/bsc.js';
import { cryptoSetupDiagnostics } from '../apps/api/src/payments/crypto-service.js';
import { stripeReadiness } from '../apps/api/src/payments/stripe-service.js';
import { smtpConfigured } from '../apps/api/src/mail-auth.js';
const flag=(name,ok)=>console.log(`${ok?'OK':'FIX'}: ${name}`);
try {
 await connectDB();const info=dbInfo();let transactions=false,ownerReady=false;
 if(info.driver==='mongo'&&info.connected){
  const db=nativeDatabase(), hello=await db.admin().command({hello:1});transactions=Boolean(hello.setName||hello.msg==='isdbgrid');
  const email=String(process.env.PLATFORM_OWNER_EMAIL||'').trim().toLowerCase();
  if(email)ownerReady=Boolean(await db.collection('users').findOne({email,emailVerified:true,mfaEnabled:true}));
 }
 const jwt=String(process.env.JWT_SECRET||'');
 flag('MongoDB connected',info.driver==='mongo'&&info.connected);flag('MongoDB supports transactions (replica set or Atlas)',transactions);
 flag('Strong non-placeholder JWT_SECRET',jwt.length>=32&&!/demo-jwt-secret|change[-_ ]?me|replace[-_ ]?me/i.test(jwt));
 flag('SMTP configured (delivery is checked separately)',smtpConfigured());
 flag('Verified owner with MFA configured',ownerReady);
 flag('BSC public receiving address format',validAddress(process.env.BSC_USDT_RECEIVING_ADDRESS));
 flag('BSC RPC configured',Boolean(String(process.env.BSC_RPC_URL||'').trim()));
 const crypto=await cryptoSetupDiagnostics();
 for(const [name,ok] of Object.entries(crypto.checks))console.log(`${ok===null?'NOT CHECKED':ok?'OK':'FIX'}: crypto.${name}`);
 flag('Crypto payment prerequisites and BSC RPC check',crypto.available);
 flag('Stripe payment configuration prerequisites',Boolean((await stripeReadiness()).available));
 console.log('SMTP: run npm run smtp:check -- you@example.com; Stripe configuration does not prove processor connectivity. Crypto checks RPC but not a real transfer. Never share secrets.');
} catch {console.error('Payment setup check could not complete. Check MongoDB configuration and run npm run db:check.');process.exitCode=1;}
finally{await disconnectDB();}
