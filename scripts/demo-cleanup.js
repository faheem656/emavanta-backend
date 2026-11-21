import { loadEnv } from '../packages/shared/env.js';
import { connectDB, disconnectDB, isMemoryMode, nativeDatabase, withMongoTransaction } from '../packages/database/store.js';
import { inspectLegacyDemo, removeLegacyDemo } from '../packages/database/demo-cleanup.js';
loadEnv();const apply=process.argv.includes('--apply');
try {
 if(isMemoryMode())throw new Error('MONGODB_URI is required; no changes were made.');
 await connectDB();
 const opts={ownerEmail:process.env.PLATFORM_OWNER_EMAIL};
 const result=apply?await withMongoTransaction((db,session)=>removeLegacyDemo(db,{...opts,session})):await inspectLegacyDemo(nativeDatabase(),opts);
 console.log(apply?'Cleanup result:':'Dry run (no records deleted):');
 for(const item of result)console.log(`${item.id}: ${item.status}${item.reason?` (${item.reason})`:''}`);
 console.log('Only exact unmodified legacy seed IDs are eligible. Demo workspace and other data are retained.');
 if(!apply)console.log('After reviewing and backing up your database, run npm run demo:cleanup -- --apply to remove eligible seed users.');
} catch(e){console.error(`Cleanup failed. No change is assumed: ${e.message==='MONGODB_URI is required; no changes were made.'?e.message:'Check database connectivity and transaction support.'}`);process.exitCode=1;}
finally{await disconnectDB();}
