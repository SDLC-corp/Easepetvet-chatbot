import pino from 'pino';
import { config } from '../../config/env.js';

// Single Pino logger instance used across the whole app. Import this instead
// of calling console.log directly.

export const logger = pino({
  level: config.logLevel,
});
