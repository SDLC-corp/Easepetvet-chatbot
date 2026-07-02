import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import healthRoutes from './routes/health.routes.js';
import chatRoutes from './routes/chat.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { errorHandler } from './shared/errors/error-handler.js';
import { config } from './config/env.js';
import { describeChain } from './chat/provider-chain.js';
import { logger } from './shared/logger/logger.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
// Absolute paths to the static frontend files.
const WIDGET_DIR = path.resolve(SRC_DIR, '../../frontend/widget');
const ADMIN_DIR = path.resolve(SRC_DIR, '../../frontend/admin');

// Builds and returns the Express app: middleware, routes, and the central
// error handler. Does not start the server (see server.js), so the app stays
// importable and testable on its own.

// No-dependency CORS for the chat widget. Only configured origins are allowed
// (no wildcard). In non-production, a "null" origin (file:// pages) is allowed
// for local widget testing.
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const allowed = config.chat.widgetAllowedOrigins;
  const allowNull = config.nodeEnv !== 'production';

  if (origin && (allowed.includes(origin) || (origin === 'null' && allowNull))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // Authorization is needed for the admin dashboard's Bearer token when it is
    // hosted on a different origin (e.g. Vercel) from this backend.
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
}

export function createApp() {
  const app = express();

  // Safe, one-time chat config log (never logs API keys).
  logger.info(
    {
      answerMode: config.chat.answerMode,
      timeoutMs: config.chat.timeoutMs,
      maxTokens: config.chat.maxTokens,
      chain: describeChain(),
    },
    'Chat configuration',
  );

  app.use(express.json());
  app.use(corsMiddleware);

  // Serve the chatbot widget over HTTP: http://localhost:<PORT>/widget/demo.html
  // In development, disable caching so edits to the widget JS/CSS always show on
  // reload (no stale cached copy). Production keeps normal caching/ETags.
  app.use(
    '/widget',
    express.static(WIDGET_DIR, {
      etag: config.nodeEnv === 'production',
      lastModified: config.nodeEnv === 'production',
      setHeaders: (res) => {
        // Always revalidate in production: with the ETag on, an unchanged file is a
        // cheap 304, but a deployed widget/admin update reaches every visitor on
        // their next load instead of sitting behind a stale browser cache. Dev uses
        // no-store so local edits always show immediately.
        res.setHeader('Cache-Control', config.nodeEnv === 'production' ? 'no-cache' : 'no-store');
      },
    }),
  );

  // Serve the admin dashboard (same-origin with its API, so no extra CORS).
  app.use(
    '/admin',
    express.static(ADMIN_DIR, {
      etag: config.nodeEnv === 'production',
      lastModified: config.nodeEnv === 'production',
      setHeaders: (res) => {
        // Always revalidate in production: with the ETag on, an unchanged file is a
        // cheap 304, but a deployed widget/admin update reaches every visitor on
        // their next load instead of sitting behind a stale browser cache. Dev uses
        // no-store so local edits always show immediately.
        res.setHeader('Cache-Control', config.nodeEnv === 'production' ? 'no-cache' : 'no-store');
      },
    }),
  );

  app.use(healthRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(errorHandler);

  return app;
}
