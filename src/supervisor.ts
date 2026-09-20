// Keeps the API answering while a new version is put in place ("zero-downtime deploys").
//
// This small process is what `npm run start:prod` starts. It does no API work itself: it runs the real server
// (dist/server.js) as a worker. To deploy, the new files are copied over dist/ and this process is asked to reload:
//   1. a NEW worker starts from the new files and joins the same port,
//   2. once it says it is ready, the OLD worker stops taking new requests, finishes the ones in flight and exits.
// If the new worker does not become ready, it is discarded and the old one keeps serving as if nothing happened.
//
// Control (loopback only, port SUPERVISOR_PORT, default 3468):
//   GET /status   who is running, and a fingerprint of this file (a changed supervisor needs a real restart)
//   POST /reload  do the swap above; answers 200 when the new worker is serving, 500 (old one kept) otherwise
//   POST /stop    drain and exit (used before a full restart, e.g. when dependencies changed)
// A worker that dies by itself is started again (backing off if it keeps dying).
import cluster from 'node:cluster';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, unlinkSync, type WriteStream } from 'node:fs';
import http from 'node:http';
import { EOL } from 'node:os';
import path from 'node:path';

const CONTROL_PORT = Number(process.env.SUPERVISOR_PORT) || 3468;
const READY_TIMEOUT_MS = Number(process.env.SUPERVISOR_READY_TIMEOUT_MS) || 45_000;
const DRAIN_MS = Number(process.env.SUPERVISOR_DRAIN_MS) || 30_000;
/** How long a retiring worker answers with "Connection: close" before it is closed. */
const DRAIN_GRACE_MS = Number(process.env.SUPERVISOR_DRAIN_GRACE_MS) || 2_500;
/** A version that predates the "ready" message is trusted once it is listening and has stayed up this long. */
const LEGACY_SETTLE_MS = 6_000;

// Everything the workers print goes to one file per day (LOG_DIR, default ./logs, kept LOG_RETENTION_DAYS = 30 days).
// Nothing grows without limit, and `node scripts/search-logs.mjs` can find a request id or a word across the days.
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS) || 30;

class DailyLogs {
  private day = '';
  private out: WriteStream | null = null;
  private err: WriteStream | null = null;

  private open(now = new Date()): void {
    const day = now.toISOString().slice(0, 10);
    if (day === this.day && this.out && this.err) return;
    this.out?.end();
    this.err?.end();
    mkdirSync(LOG_DIR, { recursive: true });
    this.day = day;
    this.out = createWriteStream(path.join(LOG_DIR, `desk-api-${day}.log`), { flags: 'a' });
    this.err = createWriteStream(path.join(LOG_DIR, `desk-api-${day}.err.log`), { flags: 'a' });
    this.removeOld(now);
  }

  private removeOld(now: Date): void {
    const cutoff = now.getTime() - LOG_RETENTION_DAYS * 86_400_000;
    for (const name of readdirSync(LOG_DIR)) {
      const m = /^desk-api-(\d{4}-\d{2}-\d{2})(\.err)?\.log$/.exec(name);
      if (m && Date.parse(`${m[1]}T00:00:00Z`) < cutoff) {
        try { unlinkSync(path.join(LOG_DIR, name)); } catch { /* in use or already gone */ }
      }
    }
  }

  write(chunk: Buffer | string, errorStream = false): void {
    try {
      this.open();
      (errorStream ? this.err : this.out)?.write(chunk);
    } catch {
      // A full disk must never take the service down; the line is simply lost.
    }
  }
}
const logs = new DailyLogs();
const fingerprint = createHash('sha256').update(readFileSync(__filename)).digest('hex');
const log = (msg: string, extra: Record<string, unknown> = {}) => {
  const line = JSON.stringify({ level: 30, time: Date.now(), component: 'supervisor', msg, ...extra }) + EOL;
  process.stdout.write(line);
  logs.write(line);
};

type Worker = ReturnType<typeof cluster.fork>;
const serving = new Set<Worker>();
const retiring = new Set<Worker>();
let reloading = false;
let stopping = false;
let crashDelayMs = 0;

cluster.setupPrimary({ exec: path.join(__dirname, 'server.js'), silent: true });

/** Starts a worker and resolves when it is serving; rejects if it dies or is not ready in time. */
function startWorker(): Promise<Worker> {
  return new Promise((resolve, reject) => {
    const worker = cluster.fork();
    worker.process.stdout?.on('data', (c: Buffer) => logs.write(c));
    worker.process.stderr?.on('data', (c: Buffer) => logs.write(c, true));
    let listening = false;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      clearTimeout(settle);
      worker.off('message', onMessage);
      worker.off('listening', onListening);
      worker.off('exit', onExit);
      if (err) reject(err);
      else resolve(worker);
    };
    const onMessage = (m: unknown) => {
      if ((m as { type?: string } | null)?.type === 'ready') finish();
    };
    let settle: NodeJS.Timeout;
    const onListening = () => {
      listening = true;
      settle = setTimeout(() => finish(), LEGACY_SETTLE_MS);
    };
    const onExit = (code: number | null) => finish(new Error(`the new worker exited before it was ready (code ${code})`));
    const timeout = setTimeout(() => finish(new Error(`the new worker was not ready within ${READY_TIMEOUT_MS / 1000}s${listening ? '' : ' (it never started listening)'}`)), READY_TIMEOUT_MS);
    worker.on('message', onMessage);
    worker.on('listening', onListening);
    worker.on('exit', onExit);
  });
}

/** Stops sending the worker new requests, lets its current ones finish, then ends it. */
function retire(worker: Worker): Promise<void> {
  serving.delete(worker);
  retiring.add(worker);
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      log('a worker did not finish in time; ending it', { pid: worker.process.pid });
      worker.process.kill();
    }, DRAIN_MS);
    worker.once('exit', () => {
      clearTimeout(force);
      retiring.delete(worker);
      resolve();
    });
    if (worker.isDead()) return;
    // Two steps: first ask it to answer with "Connection: close" for a moment, so kept-alive clients move on by
    // themselves; then close it. Closing at once could cut a request that a client sent at that very instant.
    worker.send({ type: 'drain' });
    setTimeout(() => { if (!worker.isDead()) worker.disconnect(); }, DRAIN_GRACE_MS);
  });
}

async function reload(): Promise<{ ok: boolean; message: string }> {
  if (stopping) return { ok: false, message: 'shutting down' };
  if (reloading) return { ok: false, message: 'a reload is already in progress' };
  reloading = true;
  try {
    const before = [...serving];
    let fresh: Worker;
    try {
      fresh = await startWorker();
    } catch (err) {
      // Whatever half-started is thrown away; the old worker was never touched.
      for (const w of Object.values(cluster.workers ?? {})) if (w && !before.includes(w) && !retiring.has(w) && !serving.has(w)) w.process.kill();
      log('reload failed; the previous worker keeps serving', { error: (err as Error).message });
      return { ok: false, message: (err as Error).message };
    }
    trackUnexpectedExit(fresh);
    serving.add(fresh);
    log('new worker is serving', { pid: fresh.process.pid, replacing: before.map((w) => w.process.pid) });
    await Promise.all(before.map(retire));
    log('reload complete', { pid: fresh.process.pid });
    return { ok: true, message: `now serving from pid ${fresh.process.pid}` };
  } finally {
    reloading = false;
  }
}

/** A worker that dies while serving (and was not retired by us) is replaced. */
function trackUnexpectedExit(worker: Worker): void {
  worker.once('exit', (code, signal) => {
    if (!serving.delete(worker) || stopping) return;
    log('a worker died by itself; starting another', { pid: worker.process.pid, code, signal, waitMs: crashDelayMs });
    const wait = crashDelayMs;
    crashDelayMs = Math.min(crashDelayMs ? crashDelayMs * 2 : 1_000, 30_000);
    setTimeout(() => void startAgain(), wait);
  });
}

async function startAgain(): Promise<void> {
  if (stopping || reloading || serving.size > 0) return;
  try {
    const worker = await startWorker();
    trackUnexpectedExit(worker);
    serving.add(worker);
    setTimeout(() => { if (serving.has(worker)) crashDelayMs = 0; }, 60_000).unref();
  } catch (err) {
    log('replacement worker did not start', { error: (err as Error).message });
    const wait = crashDelayMs;
    crashDelayMs = Math.min(crashDelayMs ? crashDelayMs * 2 : 1_000, 30_000);
    setTimeout(() => void startAgain(), wait);
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('stopping');
  await Promise.all([...serving, ...retiring].map(retire));
  control.close();
  process.exit(0);
}

const control = http.createServer((req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/status') {
    return reply(200, { pid: process.pid, fingerprint, reloading, workers: [...serving].map((w) => w.process.pid), draining: [...retiring].map((w) => w.process.pid) });
  }
  if (req.method === 'POST' && req.url === '/reload') {
    void reload().then((r) => reply(r.ok ? 200 : 500, r));
    return;
  }
  if (req.method === 'POST' && req.url === '/stop') {
    reply(200, { ok: true });
    void stop();
    return;
  }
  reply(404, { error: 'unknown control request' });
});

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

startWorker()
  .then((worker) => {
    trackUnexpectedExit(worker);
    serving.add(worker);
    control.listen(CONTROL_PORT, '127.0.0.1', () => log('supervisor ready', { control: CONTROL_PORT, pid: worker.process.pid }));
  })
  .catch((err: Error) => {
    console.error('the first worker did not start:', err.message);
    process.exit(1);
  });
