// Public: the incident history behind the status page, and the changelog as JSON and as an Atom feed.
// Administrators: open an incident and post updates to it.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, validationError } from '../middleware/http-error';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { recordSecurityEvent } from '../modules/audit/security-events';
import { changelogAtom, loadChangelog } from '../domain/status/changelog';
import { addIncidentUpdate, INCIDENT_SEVERITIES, INCIDENT_STATUSES, listIncidents, openIncident } from '../domain/status/incidents';

export async function incidentsHandler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.header('Cache-Control', 'public, max-age=30').send(await listIncidents());
}

export async function changelogHandler(request: FastifyRequest, reply: FastifyReply) {
  const limit = Math.min(100, Math.max(1, Number.parseInt((request.query as { limit?: string }).limit ?? '20', 10) || 20));
  return reply.header('Cache-Control', 'public, max-age=300').send({ hasMore: loadChangelog().length > limit, entries: loadChangelog().slice(0, limit), feed: '/v1/changelog.atom' });
}

export async function changelogAtomHandler(request: FastifyRequest, reply: FastifyReply) {
  const host = request.headers.host ?? 'api.deskbusiness.co';
  return reply.header('Cache-Control', 'public, max-age=300').type('application/atom+xml; charset=utf-8').send(changelogAtom(loadChangelog(), `https://${host}/v1/changelog.atom`));
}

const OpenSchema = z.object({
  title: z.string().trim().min(3).max(140),
  severity: z.enum(INCIDENT_SEVERITIES),
  message: z.string().trim().min(3).max(2000),
});
const UpdateSchema = z.object({ status: z.enum(INCIDENT_STATUSES), message: z.string().trim().min(3).max(2000) });

async function guard(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireAdmin(request, reply);
}

export async function openIncidentHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const parsed = OpenSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const incident = await openIncident(parsed.data);
  recordSecurityEvent(request, 'incident_opened', 'ok', { incidentId: incident.id, severity: incident.severity });
  return reply.status(201).header('Location', `/v1/status/incidents`).send({ incident });
}

export async function updateIncidentHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const { id } = request.params as { id: string };
  const parsed = UpdateSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const incident = await addIncidentUpdate(id, parsed.data.status, parsed.data.message);
  if (!incident) throw new HttpError(404, 'No such incident.', 'not_found');
  recordSecurityEvent(request, 'incident_updated', 'ok', { incidentId: id, status: parsed.data.status });
  return reply.send({ incident });
}
