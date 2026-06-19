import { AppError } from './app-error.js';
import { logger } from '../logger/logger.js';

// Central Express error-handling middleware. Must be registered last, after
// all routes. Operational AppErrors map to their status code; anything else is
// logged as an unexpected error and returned as a generic 500.

export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError && err.isOperational) {
    logger.warn({ err, path: req.path }, 'Operational error');
    return res.status(err.statusCode).json({ error: err.message });
  }

  logger.error({ err, path: req.path }, 'Unexpected error');
  return res.status(500).json({ error: 'Internal Server Error' });
}
