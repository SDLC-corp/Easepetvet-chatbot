import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';
import { logger } from '../shared/logger/logger.js';

// Raw-SQL migration runner with up/down support. Applied migrations are tracked
// in the schema_migrations table. Each migration runs inside a transaction.
//
//   node src/db/migrate.js up     apply all pending *.up.sql in order
//   node src/db/migrate.js down   roll back the latest applied migration

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      migration_name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function baseName(file) {
  return file.replace(/\.(up|down)\.sql$/, '');
}

function listUpFiles() {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.up.sql'))
    .sort();
}

async function getAppliedNames(client) {
  const { rows } = await client.query('SELECT migration_name FROM schema_migrations');
  return new Set(rows.map((row) => row.migration_name));
}

async function applyInTransaction(client, sql, recordQuery, params, name, action) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(recordQuery, params);
    await client.query('COMMIT');
    logger.info({ migration: name }, action);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function runUp(client) {
  const applied = await getAppliedNames(client);
  let count = 0;
  for (const file of listUpFiles()) {
    const name = baseName(file);
    if (applied.has(name)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await applyInTransaction(
      client,
      sql,
      'INSERT INTO schema_migrations (migration_name) VALUES ($1)',
      [name],
      name,
      'Applied migration',
    );
    count++;
  }
  if (count === 0) logger.info('No pending migrations');
}

async function runDown(client) {
  const { rows } = await client.query(
    'SELECT migration_name FROM schema_migrations ORDER BY id DESC LIMIT 1',
  );
  if (rows.length === 0) {
    logger.info('No migrations to roll back');
    return;
  }
  const name = rows[0].migration_name;
  const sql = readFileSync(join(migrationsDir, `${name}.down.sql`), 'utf8');
  await applyInTransaction(
    client,
    sql,
    'DELETE FROM schema_migrations WHERE migration_name = $1',
    [name],
    name,
    'Rolled back migration',
  );
}

async function main() {
  const command = process.argv[2];
  if (command !== 'up' && command !== 'down') {
    logger.error({ command }, 'Unknown command. Use "up" or "down".');
    process.exitCode = 1;
    return;
  }

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    if (command === 'up') {
      await runUp(client);
    } else {
      await runDown(client);
    }
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'Migration failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
