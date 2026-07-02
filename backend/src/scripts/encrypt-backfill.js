import { pool } from '../db/pool.js';
import { encryptField, emailHash, isEncrypted, encryptionEnabled } from '../shared/crypto/field-crypto.js';

// One-time backfill: encrypt any plaintext PII already stored at rest —
// chat_leads (name, email, phone) + email_hash, and chat_messages (content).
// Safe to re-run (already-encrypted rows are skipped). Run after setting
// DATA_ENCRYPTION_KEY:  npm run encrypt:backfill

async function backfillLeads() {
  const { rows } = await pool.query('SELECT id, name, email, phone FROM chat_leads');
  let updated = 0;
  for (const r of rows) {
    const sets = [];
    const vals = [];
    if (r.name != null && r.name !== '' && !isEncrypted(r.name)) {
      vals.push(encryptField(r.name)); sets.push(`name = $${vals.length}`);
    }
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
  console.log(`Encrypted name/email/phone on ${updated} lead row(s); ${rows.length - updated} already done or empty.`);
}

async function backfillMessages() {
  // Stream in batches to avoid loading a large chat history into memory at once.
  let updated = 0, scanned = 0;
  const BATCH = 500;
  let lastId = 0;
  for (;;) {
    const { rows } = await pool.query(
      'SELECT id, content FROM chat_messages WHERE id > $1 ORDER BY id ASC LIMIT $2',
      [lastId, BATCH],
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      scanned += 1;
      lastId = r.id;
      if (r.content == null || isEncrypted(r.content)) continue;
      await pool.query('UPDATE chat_messages SET content = $1 WHERE id = $2', [encryptField(r.content), r.id]);
      updated += 1;
    }
  }
  console.log(`Encrypted content on ${updated} message row(s); ${scanned - updated} already done or empty.`);
}

async function main() {
  if (!encryptionEnabled()) {
    console.error('DATA_ENCRYPTION_KEY is not set. Set it first, then re-run.');
    process.exit(1);
  }
  await backfillLeads();
  await backfillMessages();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
