'use strict';

import('./server.js').catch((error) => {
  console.error('[startup] Failed to start Emavanta API:', error);
  process.exit(1);
});
