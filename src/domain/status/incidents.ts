// Status page incidents: what went wrong, when, and how it went. An administrator opens an incident, adds updates as it moves
// (investigating, identified, monitoring, resolved) and the public status page shows the open ones and the last 30 days.
import { randomUUID } from 'node:crypto';
import { pool } from '../../db';

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export const INCIDENT_SEVERITIES = ['minor', 'major', 'critical'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export interface IncidentUpdate { status: IncidentStatus; message: string; at: string }
export interface Incident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  startedAt: string;
  resolvedAt: string | null;
  updates: IncidentUpdate[];
}

interface Row { id: string; title: string; severity: IncidentSeverity; status: IncidentStatus; started_at: string; resolved_at: string | null }

async function withUpdates(rows: Row[]): Promise<Incident[]> {
  if (rows.length === 0) return [];
  const { rows: ups } = await pool.query<{ incident_id: string; status: IncidentStatus; message: string; created_at: string }>(
    `SELECT incident_id, status, message, created_at FROM incident_updates WHERE incident_id = ANY($1) ORDER BY created_at ASC, id ASC`,
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => ({
    id: r.id, title: r.title, severity: r.severity, status: r.status, startedAt: r.started_at, resolvedAt: r.resolved_at,
    updates: ups.filter((u) => u.incident_id === r.id).map((u) => ({ status: u.status, message: u.message, at: u.created_at })),
  }));
}

/** Open incidents, and everything that started in the last `days` days, newest first. */
export async function listIncidents(days = 30): Promise<{ active: Incident[]; recent: Incident[] }> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { rows } = await pool.query<Row>(
    `SELECT id, title, severity, status, started_at, resolved_at FROM incidents WHERE started_at >= $1 OR status <> 'resolved' ORDER BY started_at DESC LIMIT 100`,
    [since],
  );
  const all = await withUpdates(rows);
  return { active: all.filter((i) => i.status !== 'resolved'), recent: all.filter((i) => i.status === 'resolved') };
}

export async function openIncident(input: { title: string; severity: IncidentSeverity; message: string }): Promise<Incident> {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO incidents (id, title, severity, status) VALUES ($1, $2, $3, 'investigating')`, [id, input.title, input.severity]);
    await client.query(`INSERT INTO incident_updates (id, incident_id, status, message, created_at) VALUES ($1, $2, 'investigating', $3, $4)`, [randomUUID(), id, input.message, new Date().toISOString()]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return (await getIncident(id))!;
}

export async function getIncident(id: string): Promise<Incident | null> {
  const { rows } = await pool.query<Row>(`SELECT id, title, severity, status, started_at, resolved_at FROM incidents WHERE id = $1`, [id]);
  return (await withUpdates(rows))[0] ?? null;
}

/** Adds an update and moves the incident to that status; "resolved" closes it. Returns null when there is no such incident. */
export async function addIncidentUpdate(id: string, status: IncidentStatus, message: string): Promise<Incident | null> {
  const { rows } = await pool.query(`UPDATE incidents SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') ELSE NULL END WHERE id = $1 RETURNING id`, [id, status]);
  if (!rows[0]) return null;
  // The time is written with milliseconds (the column default stops at whole seconds), so updates made in quick succession keep their order.
  await pool.query(`INSERT INTO incident_updates (id, incident_id, status, message, created_at) VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), id, status, message, new Date().toISOString()]);
  return getIncident(id);
}
