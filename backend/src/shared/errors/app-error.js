// Operational error with an HTTP status code. Throw this for expected,
// handled failures (bad input, not found, etc.) so the error handler can
// respond predictably. Unexpected errors are treated as non-operational.

export class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }
}
