import '../api/src/env.js'; // Load backend configuration before initializing storage and workers.
import { startWorkers } from '../api/src/workers/index.js';
import { startSchedulerSweep } from '../api/src/workers/schedulerSweep.js';
import { closeQueues } from '../../packages/queue/index.js';
import { connectDB, disconnectDB } from '../../packages/database/store.js';

await connectDB();
startWorkers();
const stopSchedulerSweep = startSchedulerSweep();
console.log('[worker] ready. Press Ctrl+C to stop.');
const shutdown = async () => { await stopSchedulerSweep(); await closeQueues(); await disconnectDB(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
