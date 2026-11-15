import { Router, type Request, type Response } from 'express';
import { type Event } from '@prisma/client';
import { requireOrganizer, type AuthOptions } from './auth/routes.js';
import { requireSameOrigin } from './auth/csrf.js';
import { AuthError } from './auth/security.js';
import { getDatabase } from './database.js';

const fields = ['title', 'description', 'location', 'startsAt', 'endsAt', 'timeZone', 'status'];
const selection = { id: true, title: true, description: true, location: true, startsAt: true, endsAt: true,
  timeZone: true, status: true, createdAt: true, updatedAt: true } as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message: string): never => { throw new AuthError(400, message); };

function input(body: Record<string, unknown>, current?: Event) {
  if (!Object.keys(body).length || Object.keys(body).some(key => !fields.includes(key))) invalid('Provide only editable event fields');
  const data: Partial<Pick<Event, 'title' | 'description' | 'location' | 'timeZone' | 'status'>> = {};
  for (const [key, max] of [['title', 200], ['description', 4000], ['location', 300]] as const) {
    if (!(key in body)) continue;
    const value = body[key];
    if (key !== 'title' && value === null) { data[key] = null; continue; }
    if (typeof value !== 'string' || value.length > max || (key === 'title' && !value.trim())) invalid(`Invalid ${key}`);
    data[key] = (value as string).trim();
  }
  if (!current && !data.title) invalid('Title is required');
  if ('timeZone' in body) {
    if (typeof body.timeZone !== 'string' || body.timeZone.length > 80) invalid('Invalid time zone');
    try { new Intl.DateTimeFormat('en', { timeZone: body.timeZone as string }); } catch { invalid('Invalid time zone'); }
    data.timeZone = body.timeZone as string;
  }
  if ('status' in body) {
    if (body.status !== 'DRAFT' && body.status !== 'OPEN') invalid('Status must be DRAFT or OPEN; use cancellation separately');
    data.status = body.status as 'DRAFT' | 'OPEN';
  }
  const dates: { startsAt?: Date | null; endsAt?: Date | null } = {};
  for (const key of ['startsAt', 'endsAt'] as const) {
    if (!(key in body)) continue;
    const value = body[key];
    if (value === null) { dates[key] = null; continue; }
    // Require canonical UTC to reject locale-dependent input and calendar overflow.
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) invalid(`Invalid ${key}; use UTC ISO-8601`);
    const date = new Date(value as string);
    const canonical = (value as string).length === 20 ? (value as string).slice(0, -1) + '.000Z' : value;
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) invalid(`Invalid ${key}`);
    dates[key] = date;
  }
  const start = dates.startsAt === undefined ? current?.startsAt : dates.startsAt;
  const end = dates.endsAt === undefined ? current?.endsAt : dates.endsAt;
  if (end && (!start || end <= start)) invalid('End must be after start');
  return { ...data, ...dates };
}

export function createEventsRouter(options: AuthOptions = {}) {
  const router = Router();
  const database = options.database ?? getDatabase;
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(requireOrganizer(options), requireSameOrigin(options.settings));
  const action = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: (error?: unknown) => void) => { fn(req, res).catch(next); };
  const idOf = (req: Request) => {
    if (!uuid.test(req.params.eventId)) throw new AuthError(404, 'Event not found');
    return req.params.eventId;
  };
  router.post('/', action(async (req, res) => {
    const parsed = input(req.body);
    const organizerId = res.locals.organizer.id as string;
    const event = await database().$transaction(async tx => {
      // Validation produces scalar fields only; never accept nested writes or organizerId.
      const event = await tx.event.create({ data: { ...parsed, title: parsed.title!, organizerId }, select: selection });
      await tx.auditEntry.create({ data: { eventId: event.id, actorUserId: organizerId, action: 'event.create', entityType: 'Event', entityId: event.id } });
      return event;
    });
    res.status(201).location(`/api/v1/events/${event.id}`).json({ event });
  }));
  router.get('/', action(async (req, res) => {
    if (Object.keys(req.query).some(key => !['limit', 'offset', 'status'].includes(key))) invalid('Unsupported list filter');
    const number = (value: unknown, fallback: number, max: number) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) > max) invalid('Invalid pagination');
      return Number(value);
    };
    const limit = number(req.query.limit, 20, 100); const offset = number(req.query.offset, 0, 10000);
    if (!limit) invalid('Limit must be positive');
    const status = req.query.status;
    if (status !== undefined && !['DRAFT', 'OPEN', 'FINALIZED', 'CANCELLED'].includes(status as string)) invalid('Invalid status');
    const events = await database().event.findMany({ where: { organizerId: res.locals.organizer.id,
      ...(status ? { status: status as Event['status'] } : {}) }, select: selection, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: offset, take: limit });
    res.json({ events, limit, offset });
  }));
  router.get('/:eventId', action(async (req, res) => {
    const event = await database().event.findFirst({ where: { id: idOf(req), organizerId: res.locals.organizer.id }, select: selection });
    if (!event) throw new AuthError(404, 'Event not found');
    res.json({ event });
  }));
  const mutate = (cancel: boolean) => action(async (req, res) => {
    const id = idOf(req); const organizerId = res.locals.organizer.id as string;
    const event = await database().$transaction(async tx => {
      // Serialize patch/cancel so stale edits cannot reopen cancelled outings.
      await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${id}::uuid AND "organizerId" = ${organizerId}::uuid FOR UPDATE`;
      const current = await tx.event.findFirst({ where: { id, organizerId } });
      if (!current) throw new AuthError(404, 'Event not found');
      if (cancel && Object.keys(req.body).length) invalid('Cancellation requires an empty JSON object');
      if (!cancel && ['CANCELLED', 'FINALIZED'].includes(current.status)) throw new AuthError(409, 'Event is no longer editable');
      if (cancel && current.status === 'CANCELLED') return tx.event.findUniqueOrThrow({ where: { id }, select: selection });
      const data = cancel ? { status: 'CANCELLED' as const } : input(req.body, current);
      await tx.event.updateMany({ where: { id, organizerId }, data });
      if (cancel) await tx.invitationToken.updateMany({ where: { eventId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditEntry.create({ data: { eventId: id, actorUserId: organizerId, action: cancel ? 'event.cancel' : 'event.update', entityType: 'Event', entityId: id } });
      return tx.event.findUniqueOrThrow({ where: { id }, select: selection });
    });
    res.json({ event });
  });
  router.patch('/:eventId', mutate(false));
  router.post('/:eventId/cancel', mutate(true));
  return router;
}
