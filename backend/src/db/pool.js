import pg from 'pg';
import { config } from '../config/env.js';

// Single PostgreSQL connection pool for the whole app. Repositories and the
// migration runner import this; connections are created in one place only.
//
// Connection: either a single DATABASE_URL (managed Postgres like Render) or the
// individual PG* vars. SSL is enabled when PGSSL=true, or automatically for a
// DATABASE_URL unless PGSSL=false (managed providers usually require it).

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
const sslEnabled = process.env.PGSSL === 'true' || (!!databaseUrl && process.env.PGSSL !== 'false');
const ssl = sslEnabled ? { rejectUnauthorized: false } : false;

export const pool = new Pool(
  databaseUrl
    ? { connectionString: databaseUrl, ssl }
    : {
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        ssl,
      },
);
