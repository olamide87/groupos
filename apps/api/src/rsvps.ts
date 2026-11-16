import { Router, type Request, type Response, type RequestHandler } from 'express';
import { type Prisma, type Rsvp, type RsvpResponse } from '@prisma/client';
import { type AuthOptions, requireOrganizer } from './auth/routes.js';
import { AuthError, readAuthSettings } from './auth/security.js';
import { requireSameOrigin } from './auth/csrf.js';
import { withParticipant } from './invitations.js';
import { getDatabase } from './database.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const action = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next) => { fn(req, res).catch(next); };
const headers: RequestHandler = (_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); };
const snapshot = (rsvp: Rsvp | null) => ({ response: rsvp?.response ?? null, version: rsvp?.version ?? 0, updatedAt: rsvp?.updatedAt ?? null });
function pagination(req: Request) {
  if (Object.keys(req.query).some(k => !['limit', 'offset'].includes(k))) throw new AuthError(400, 'Unsupported query');
  const parse = (value: unknown, fallback: number, max: number, min: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new AuthError(400, 'Invalid pagination');
    return Number(value);
  };
  return { limit: parse(req.query.limit, 20, 100, 1), offset: parse(req.query.offset, 0, 10000, 0) };
}
async function history(tx: Prisma.TransactionClient, participantId: string, page: ReturnType<typeof pagination>) {
  return tx.rsvpHistory.findMany({ where: { participantId }, select: { id: true, response: true, revision: true, recordedAt: true },
    orderBy: [{ revision: { sort: 'asc', nulls: 'first' } }, { recordedAt: 'asc' }, { id: 'asc' }], take: page.limit, skip: page.offset });
}

export function createParticipantRsvpRouter(options: AuthOptions = {}) {
  const router = Router(); const database = options.database ?? getDatabase; const settings = options.settings ?? readAuthSettings;
  router.use(headers, requireSameOrigin(settings));
  router.get('/events/:eventId/rsvp', action(async (req, res) => {
    const result = await withParticipant(req, database(), settings(), async (tx, identity) => ({
      rsvp: snapshot(await tx.rsvp.findUnique({ where: { participantId: identity.participantId } })),
      canRespond: (await tx.event.findUniqueOrThrow({ where: { id: identity.eventId }, select: { status: true } })).status === 'OPEN',
    }));
    res.json(result);
  }));
  router.get('/events/:eventId/rsvp/history', action(async (req, res) => {
    const page = pagination(req);
    const rows = await withParticipant(req, database(), settings(), (tx, identity) => history(tx, identity.participantId, page));
    res.json({ history: rows, ...page });
  }));
  router.post('/events/:eventId/rsvp', action(async (req, res) => {
    const { response, requestId, expectedVersion } = req.body;
    if (Object.keys(req.body).some(k => !['response', 'requestId', 'expectedVersion'].includes(k))
      || !['YES', 'NO', 'MAYBE'].includes(response) || typeof requestId !== 'string' || !uuid.test(requestId)
      || !Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 2147483646) throw new AuthError(400, 'Invalid RSVP submission');
    const result = await withParticipant(req, database(), settings(), async (tx, identity) => {
      const event = await tx.event.findUniqueOrThrow({ where: { id: identity.eventId } });
      if (event.status !== 'OPEN') throw new AuthError(409, 'Event no longer accepts responses');
      const participantId = identity.participantId; const normalizedId = requestId.toLowerCase();
      const previous = await tx.rsvpSubmission.findUnique({ where: { participantId_requestId: { participantId, requestId: normalizedId } } });
      const current = await tx.rsvp.findUnique({ where: { participantId } });
      if (previous) {
        if (previous.response !== response || previous.expectedVersion !== expectedVersion) throw new AuthError(409, 'Request ID was already used with different input');
        return { rsvp: snapshot(current), replayed: true, changed: false };
      }
      if ((current?.version ?? 0) !== expectedVersion) throw new AuthError(409, 'RSVP changed; reload before submitting');
      const changed = current?.response !== response;
      let next = current;
      if (changed) {
        const version = expectedVersion + 1;
        next = await tx.rsvp.upsert({ where: { participantId }, create: { participantId, response: response as RsvpResponse, version }, update: { response: response as RsvpResponse, version } });
        await tx.rsvpHistory.create({ data: { participantId, response: response as RsvpResponse, revision: version } });
        await tx.auditEntry.create({ data: { eventId: identity.eventId, action: 'rsvp.change', entityType: 'Rsvp', entityId: participantId } });
      }
      await tx.rsvpSubmission.create({ data: { participantId, requestId: normalizedId, response: response as RsvpResponse, expectedVersion } });
      return { rsvp: snapshot(next), replayed: false, changed };
    }, true);
    res.json(result);
  }));
  return router;
}

export function createOrganizerRsvpRouter(options: AuthOptions = {}) {
  const router = Router(); const database = options.database ?? getDatabase;
  router.use(headers, requireOrganizer(options));
  async function owned<T>(req: Request, organizerId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    if (!uuid.test(req.params.eventId)) throw new AuthError(404, 'Event not found');
    return database().$transaction(async tx => {
      // Shares the event lock used by invitation/RSVP writes for consistent counts.
      await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${req.params.eventId}::uuid AND "organizerId" = ${organizerId}::uuid FOR SHARE`;
      if (!await tx.event.findFirst({ where: { id: req.params.eventId, organizerId } })) throw new AuthError(404, 'Event not found');
      return operation(tx);
    });
  }
  router.get('/:eventId/rsvps', action(async (req, res) => {
    const page = pagination(req);
    const result = await owned(req, res.locals.organizer.id, async tx => {
      const total = await tx.participant.count({ where: { eventId: req.params.eventId } });
      const groups = await tx.rsvp.groupBy({ by: ['response'], where: { participant: { eventId: req.params.eventId } }, _count: { _all: true } });
      const counts = { total, YES: 0, NO: 0, MAYBE: 0, pending: total };
      for (const group of groups) { counts[group.response] = group._count._all; counts.pending -= group._count._all; }
      const rows = await tx.participant.findMany({ where: { eventId: req.params.eventId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: page.limit, skip: page.offset,
        select: { id: true, displayName: true, rsvp: true } });
      return { counts, participants: rows.map(p => ({ id: p.id, displayName: p.displayName, rsvp: snapshot(p.rsvp) })) };
    });
    res.json({ ...result, ...page });
  }));
  router.get('/:eventId/participants/:participantId/rsvp-history', action(async (req, res) => {
    const page = pagination(req);
    const rows = await owned(req, res.locals.organizer.id, async tx => {
      if (!uuid.test(req.params.participantId) || !await tx.participant.findFirst({ where: { id: req.params.participantId, eventId: req.params.eventId } })) throw new AuthError(404, 'Participant not found');
      return history(tx, req.params.participantId, page);
    });
    res.json({ history: rows, ...page });
  }));
  return router;
}
