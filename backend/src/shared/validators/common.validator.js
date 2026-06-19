// Custom validation helpers shared across the app. No external validation
// library (Zod is not used in MVP). Each function does one clear check.

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

export function isOneOf(value, allowed) {
  return allowed.includes(value);
}
