import crypto from 'crypto';

// Field-level encryption for PII at rest (email, phone). AES-256-GCM with a key
// derived from DATA_ENCRYPTION_KEY. Encrypted values are prefixed so reads can
// tell encrypted vs. legacy-plaintext values and stay backward compatible.
//
// Enable by setting DATA_ENCRYPTION_KEY (any sufficiently long secret string).
// If it is unset, encryption is a no-op (values stored as plaintext) so the app
// still runs — set the key in production to turn encryption on.

const PREFIX = 'enc:v1:';
let cachedKey = null;
let cachedFor = null;

function getKey() {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) return null;
  if (cachedFor !== raw) {
    // Derive a stable 32-byte key from whatever secret is provided.
    cachedKey = crypto.createHash('sha256').update(String(raw)).digest();
    cachedFor = raw;
  }
  return cachedKey;
}

export function encryptionEnabled() {
  return Boolean(getKey());
}

// Encrypts a value for storage. Returns the input unchanged when empty or when
// encryption is disabled (no key).
export function encryptField(plain) {
  if (plain == null || plain === '') return plain;
  const key = getKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

// Decrypts a stored value. Plain/legacy values (no prefix) are returned as-is, so
// existing un-encrypted rows keep working. Returns null if decryption fails.
export function decryptField(stored) {
  if (stored == null || typeof stored !== 'string' || !stored.startsWith(PREFIX)) return stored;
  const key = getKey();
  if (!key) return null; // encrypted value but no key available
  try {
    const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':');
    const iv = Buffer.from(ivB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    return null;
  }
}

// Deterministic keyed hash of an email, used for exact-match admin search since
// the encrypted email column is not searchable. Returns null when no key.
export function emailHash(email) {
  if (!email) return null;
  const key = getKey();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(String(email).trim().toLowerCase()).digest('hex');
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}
