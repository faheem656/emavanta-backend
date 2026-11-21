/**
 * Loads `.env` before anything else in the API is evaluated.
 * Import this as the FIRST import of the entry module so `process.env`
 * is populated by the time config/plugins read it.
 */
import { loadEnv } from '../../../packages/shared/env.js';

export const env = loadEnv();
if (env.files.length) console.log(`[env] loaded ${env.files.join(', ')}`);
