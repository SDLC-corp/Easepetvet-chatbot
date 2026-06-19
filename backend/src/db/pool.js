import pg from 'pg';
import { config } from '../config/env.js';

// Single PostgreSQL connection pool for the whole app. Repositories and the
// migration runner import this; connections are created in one place only.

const { Pool } = pg;

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
});
