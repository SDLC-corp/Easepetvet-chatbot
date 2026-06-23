import { pool } from '../db/pool.js';
import { encryptField, emailHash, isEncrypted, encryptionEnabled } from '../shared/crypto/field-crypto.js';

// One-time backfill: encrypt any plaintext email/phone already stored in
// chat_leads and populate email_hash. Safe to re-run (already-encrypted rows are
// skipped). Run after setting DATA_ENCRYPTION_KEY:  npm run encrypt:backfill

async function main() {
  if (!encryptionEnabled()) {
    console.error('DATA_ENCRYPTION_KEY is not set. Set it first, then re-run.');
    process.exit(1);
  }
  const { rows } = await pool.query('SELECT id, email, phone FROM chat_leads');
  let updated = 0;
  for (const r of rows) {
    const sets = [];
    const vals = [];
    if (r.email != null && !isEncrypted(r.email)) {
      vals.push(encryptField(r.email)); sets.push(`email = $${vals.length}`);
      vals.push(emailHash(r.email)); sets.push(`email_hash = $${vals.length}`);
    }
    if (r.phone != null && !isEncrypted(r.phone)) {
      vals.push(encryptField(r.phone)); sets.push(`phone = $${vals.length}`);
    }
    if (sets.length === 0) continue;
    vals.push(r.id);
    await pool.query(`UPDATE chat_leads SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    updated += 1;
  }
  console.log(`Encrypted email/phone on ${updated} lead row(s); ${rows.length - updated} already done or empty.`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
