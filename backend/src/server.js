import { createApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './shared/logger/logger.js';
import { startSyncScheduler } from './admin/sync-scheduler.js';

// Entry point. Reads validated config, builds the app, and starts listening.

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, 'Server listening');
  // Optional automatic monthly website sync (no-op unless ADMIN_SYNC_AUTO_ENABLED=true).
  startSyncScheduler();
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
