import pg from 'pg';

const { Pool } = pg;

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * How the service talks to Postgres. Every limit exists so one bad moment cannot become an outage:
 *  - connectionTimeoutMillis: waiting for a free connection, or for a database that is not answering, gives up in
 *    seconds instead of hanging a request (and every request queued behind it) forever;
 *  - statement_timeout / query_timeout: a runaway query is cancelled by the database (and abandoned by the client);
 *  - idle_in_transaction_session_timeout: a request that dies mid-transaction cannot hold locks indefinitely;
 *  - idleTimeoutMillis: unused connections are released;
 *  - max: a ceiling on connections so a traffic burst cannot exhaust the database's own connection limit.
 * Each can be changed with an environment variable if it ever needs to be.
 */
export function poolOptions(connectionString: string | undefined): pg.PoolConfig {
  const statementTimeout = intFromEnv('DB_STATEMENT_TIMEOUT_MS', 20_000);
  return {
    connectionString,
    max: intFromEnv('DB_POOL_MAX', 10),
    connectionTimeoutMillis: intFromEnv('DB_CONNECT_TIMEOUT_MS', 5_000),
    idleTimeoutMillis: intFromEnv('DB_IDLE_TIMEOUT_MS', 30_000),
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout + 5_000,
    idle_in_transaction_session_timeout: intFromEnv('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', 30_000),
    application_name: 'desk-api',
  };
}

export const pool = new Pool(poolOptions(process.env.DATABASE_URL));

// An idle connection that the database drops (a restart, a failover, a network blip) makes the pool emit 'error'. With
// no listener Node treats that as an uncaught exception and the whole service exits. Log it and carry on: the pool
// discards the dead connection and the next query opens a fresh one.
let lastReported = 0;
pool.on('error', (err) => {
  const now = Date.now();
  if (now - lastReported < 10_000) return; // a restart drops many connections at once: say it once
  lastReported = now;
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'db_pool_error', message: err.message, ts: new Date(now).toISOString() })}\n`);
});
