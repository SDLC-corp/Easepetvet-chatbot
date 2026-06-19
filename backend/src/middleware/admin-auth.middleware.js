import crypto from 'node:crypto';
import { config } from '../config/env.js';

// Protects all /api/admin/* routes with a static bearer token.
// - If no token is configured, the dashboard is treated as disabled (503), so
//   the feature stays off safely until an admin sets ADMIN_DASHBOARD_TOKEN.
// - Otherwise the request must send "Authorization: Bearer <token>".
// The token is never logged or echoed back in any response.

// Constant-time compare to avoid leaking the token via response timing.
function tokensMatch(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function requireAdmin(req, res, next) {
  const expected = config.admin.token;
  if (!expected) {
    return res.status(503).json({ error: 'Admin dashboard is not configured.' });
  }

  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !tokensMatch(match[1].trim(), expected)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  return next();
}
