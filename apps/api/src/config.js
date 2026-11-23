import './env.js';
import { describeMongoUri } from '../../../packages/shared/env.js';
import { readSessionTtlDays } from '../../../packages/security/session-policy.js';

const mongo = describeMongoUri(process.env.MONGODB_URI);

export const config = Object.freeze({
  port: Number(process.env.API_PORT || process.env.PORT || 4000),
  host: '0.0.0.0',
  // Simulated auth and mock mail are available only in isolated test processes.
  demo: process.env.DEMO_MODE === 'true' && process.env.NODE_ENV === 'test',
  storage: process.env.MONGODB_URI ? 'mongo' : 'memory',
  mongo: { configured: mongo.configured, host: mongo.host || null, srv: !!mongo.srv,
    database: process.env.MONGODB_DB || mongo.database || 'emavanta' },
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  oauthBase: process.env.OAUTH_REDIRECT_BASE || 'http://localhost:4000',
  sessionTtlDays: readSessionTtlDays()
});
