import { Router, type Request, type Response, type RequestHandler } from 'express';
import { type Prisma, type Poll } from '@prisma/client';
import { requireOrganizer, type AuthOptions } from './auth/routes.js';
import { requireSameOrigin } from './auth/csrf.js';
import { AuthError, hashToken, readAuthSettings } from './auth/security.js';
import { getDatabase } from './database.js';
import { withParticipant } from './invitations.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const action = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next) => { fn(req, res).catch(next); };
const headers: RequestHandler = (_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); };
const bad = (message = 'Invalid poll input'): never => { throw new AuthError(400, message); };
const conflict = (message: string): never => { throw new AuthError(409, message); };
const version = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) < 2147483647;
function keys(body: Record<string, unknown>, allowed: string[]) { if (Object.keys(body).some(key => !allowed.includes(key))) bad(); }
function text(value: unknown, max: number) { if (typeof value !== 'string' || !value.trim() || value.length > max) return bad(); return value.trim(); }
function date(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return bad('Use canonical UTC timestamps');
  const parsed = new Date(value); const canonical = value.length === 20 ? value.slice(0, -1) + '.000Z' : value;
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== canonical) bad('Invalid date');
  return parsed;
}
function deadline(value: unknown) { const parsed = value === null || value === undefined ? null : date(value); if (parsed && parsed <= new Date()) bad('Closing time must be in the future'); return parsed; }
function pollOptions(value: unknown, kind: Poll['kind']) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) return bad('Provide 2–20 options');
  const options = value.map((entry, position) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return bad();
    keys(entry, kind === 'DATE' ? ['label', 'startsAt', 'endsAt'] : kind === 'BUDGET' ? ['label', 'amountMinor', 'currency'] : ['label']);
    const label = text(entry.label, 200);
    if (kind === 'DATE') {
      const startsAt = date(entry.startsAt); const endsAt = date(entry.endsAt);
      if (endsAt <= startsAt || startsAt <= new Date()) bad('Availability windows must be future intervals');
      return { label, position, startsAt, endsAt };
    }
    if (kind === 'BUDGET') {
      if (!Number.isInteger(entry.amountMinor) || entry.amountMinor < 0 || entry.amountMinor > 100000000 || !['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'NGN'].includes(entry.currency)) bad('Invalid budget amount or supported currency');
      return { label, position, amountMinor: entry.amountMinor as number, currency: entry.currency as string };
    }
    return { label, position };
  });
  if (new Set(options.map(o => o.label.toLowerCase())).size !== options.length) bad('Option labels must be distinct');
  if (kind === 'BUDGET' && new Set(options.map(o => o.currency)).size !== 1) bad('Use one currency per poll');
  return options;
}
const optionOrder = { position: 'asc' as const };
async function findPoll(tx: Prisma.TransactionClient, eventId: string, pollId: string) {
  if (!uuid.test(pollId)) throw new AuthError(404, 'Poll not found');
  const poll = await tx.poll.findFirst({ where: { id: pollId, eventId }, include: { options: { orderBy: optionOrder } } });
  if (!poll) throw new AuthError(404, 'Poll not found');
  return poll;
}
function writable(poll: Poll) { if (poll.status !== 'OPEN' || (poll.closesAt && poll.closesAt <= new Date())) conflict('Poll is closed'); }
async function ballot(tx: Prisma.TransactionClient, pollId: string, participantId: string) {
  const state = await tx.pollBallot.findUnique({ where: { pollId_participantId: { pollId, participantId } } });
  const votes = await tx.vote.findMany({ where: { pollId, participantId }, select: { optionId: true }, orderBy: { optionId: 'asc' } });
  return { version: state?.version ?? 0, optionIds: votes.map(v => v.optionId) };
}
function page(req: Request) {
  keys(req.query, ['offset']); const value = req.query.offset ?? '0';
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) > 10000) bad('Invalid offset');
  return Number(value);
}

export function createOrganizerPollRouter(options: AuthOptions = {}) {
  const router = Router(); const database = options.database ?? getDatabase;
  router.use(headers, requireOrganizer(options), requireSameOrigin(options.settings));
  async function owned<T>(req: Request, organizerId: string, write: boolean, operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    if (!uuid.test(req.params.eventId)) throw new AuthError(404, 'Event not found');
    return database().$transaction(async tx => {
      if (write) await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${req.params.eventId}::uuid AND "organizerId" = ${organizerId}::uuid FOR UPDATE`;
      else await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${req.params.eventId}::uuid AND "organizerId" = ${organizerId}::uuid FOR SHARE`;
      const event = await tx.event.findFirst({ where: { id: req.params.eventId, organizerId } });
      if (!event) throw new AuthError(404, 'Event not found');
      if (write && !['OPEN', 'DRAFT'].includes(event.status)) conflict('Event no longer permits poll changes');
      return operation(tx);
    });
  }
  const audit = (tx: Prisma.TransactionClient, req: Request, userId: string, id: string, action: string) => tx.auditEntry.create({ data: { eventId: req.params.eventId, actorUserId: userId, action, entityType: 'Poll', entityId: id } });
  router.post('/:eventId/polls', action(async (req, res) => {
    keys(req.body, ['question', 'kind', 'options', 'closesAt']);
    if (!['DATE', 'BUDGET', 'ACTIVITY'].includes(req.body.kind)) bad();
    const question = text(req.body.question, 300); const kind = req.body.kind as Poll['kind']; const choices = pollOptions(req.body.options, kind); const closesAt = deadline(req.body.closesAt);
    const poll = await owned(req, res.locals.organizer.id, true, async tx => {
      if (await tx.poll.count({ where: { eventId: req.params.eventId } }) >= 50) conflict('Event poll limit reached');
      const created = await tx.poll.create({ data: { eventId: req.params.eventId, question, kind, closesAt, options: { create: choices } }, include: { options: { orderBy: optionOrder } } });
      await audit(tx, req, res.locals.organizer.id, created.id, 'poll.create'); return created;
    });
    res.status(201).json({ poll });
  }));
  router.get('/:eventId/polls', action(async (req, res) => {
    const offset = page(req);
    const polls = await owned(req, res.locals.organizer.id, false, tx => tx.poll.findMany({ where: { eventId: req.params.eventId }, include: { options: { orderBy: optionOrder } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20, skip: offset }));
    res.json({ polls, offset, limit: 20 });
  }));
  router.patch('/:eventId/polls/:pollId', action(async (req, res) => {
    keys(req.body, ['question', 'options', 'closesAt', 'expectedVersion']);
    if (!version(req.body.expectedVersion) || !['question', 'options', 'closesAt'].some(k => k in req.body)) bad();
    const poll = await owned(req, res.locals.organizer.id, true, async tx => {
      const current = await findPoll(tx, req.params.eventId, req.params.pollId); writable(current);
      if (current.version !== req.body.expectedVersion) conflict('Poll changed; reload before editing');
      if (('options' in req.body || 'question' in req.body) && (await tx.vote.count({ where: { pollId: current.id } }) || await tx.pollBallot.count({ where: { pollId: current.id } }))) conflict('Question and options cannot change after voting begins');
      if ('options' in req.body) {
        const choices = pollOptions(req.body.options, current.kind);
        await tx.pollOption.deleteMany({ where: { pollId: current.id } });
        await tx.pollOption.createMany({ data: choices.map(o => ({ ...o, pollId: current.id })) });
      }
      const updated = await tx.poll.update({ where: { id: current.id }, data: { version: { increment: 1 }, ...('question' in req.body ? { question: text(req.body.question, 300) } : {}), ...('closesAt' in req.body ? { closesAt: deadline(req.body.closesAt) } : {}) }, include: { options: { orderBy: optionOrder } } });
      await audit(tx, req, res.locals.organizer.id, current.id, 'poll.update'); return updated;
    }); res.json({ poll });
  }));
  for (const [verb, status] of [['close', 'CLOSED'], ['cancel', 'CANCELLED']] as const) {
    router.post(`/:eventId/polls/:pollId/${verb}`, action(async (req, res) => {
      keys(req.body, ['expectedVersion']); if (!version(req.body.expectedVersion)) bad();
      const poll = await owned(req, res.locals.organizer.id, true, async tx => {
        const current = await findPoll(tx, req.params.eventId, req.params.pollId);
        if (current.status === status) return current;
        if (current.version !== req.body.expectedVersion || current.status === 'CANCELLED' || (status === 'CLOSED' && current.status !== 'OPEN')) conflict('Poll changed; reload');
        const updated = await tx.poll.update({ where: { id: current.id }, data: { status, version: { increment: 1 } }, include: { options: { orderBy: optionOrder } } });
        await audit(tx, req, res.locals.organizer.id, current.id, `poll.${verb}`); return updated;
      }); res.json({ poll });
    }));
  }
  router.get('/:eventId/polls/:pollId/results', action(async (req, res) => {
    const result = await owned(req, res.locals.organizer.id, false, async tx => {
      const poll = await findPoll(tx, req.params.eventId, req.params.pollId);
      const groups = await tx.vote.groupBy({ by: ['optionId'], where: { pollId: poll.id }, _count: { _all: true } });
      // Include explicit "none available" ballots and preserved legacy votes.
      const [respondents] = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM (
        SELECT "participantId" FROM "PollBallot" WHERE "pollId" = ${poll.id}::uuid
        UNION SELECT "participantId" FROM "Vote" WHERE "pollId" = ${poll.id}::uuid
      ) AS respondents`;
      const total = await tx.participant.count({ where: { eventId: poll.eventId } });
      const responded = Number(respondents.count);
      return { poll, counts: poll.options.map(o => ({ optionId: o.id, count: groups.find(g => g.optionId === o.id)?._count._all ?? 0 })), responded, pending: total - responded, total };
    }); res.json(result);
  }));
  return router;
}

export function createParticipantPollRouter(options: AuthOptions = {}) {
  const router = Router(); const database = options.database ?? getDatabase; const settings = options.settings ?? readAuthSettings;
  router.use(headers, requireSameOrigin(settings));
  router.get('/events/:eventId/polls', action(async (req, res) => {
    const offset = page(req);
    const result = await withParticipant(req, database(), settings(), async (tx, identity) => {
      const event = await tx.event.findUniqueOrThrow({ where: { id: identity.eventId } });
      const polls = await tx.poll.findMany({ where: { eventId: identity.eventId }, include: { options: { orderBy: optionOrder } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20, skip: offset });
      return Promise.all(polls.map(async poll => ({ ...poll, ballot: await ballot(tx, poll.id, identity.participantId), canVote: event.status === 'OPEN' && poll.status === 'OPEN' && (!poll.closesAt || poll.closesAt > new Date()) })));
    }); res.json({ polls: result, offset, limit: 20 });
  }));
  router.post('/events/:eventId/polls/:pollId/vote', action(async (req, res) => {
    keys(req.body, ['optionIds', 'expectedVersion', 'expectedPollVersion', 'requestId']);
    const { optionIds, expectedVersion, expectedPollVersion, requestId } = req.body;
    if (!Array.isArray(optionIds) || optionIds.length > 20 || optionIds.some(id => typeof id !== 'string' || !uuid.test(id)) || !version(expectedVersion) || !version(expectedPollVersion) || typeof requestId !== 'string' || !uuid.test(requestId)) bad('Invalid vote');
    const selected = (optionIds as string[]).map(id => id.toLowerCase()).sort();
    if (new Set(selected).size !== selected.length) bad('Duplicate options');
    const payloadHash = hashToken(JSON.stringify({ selected, expectedVersion, expectedPollVersion }));
    const result = await withParticipant(req, database(), settings(), async (tx, identity) => {
      if ((await tx.event.findUniqueOrThrow({ where: { id: identity.eventId } })).status !== 'OPEN') conflict('Event no longer accepts votes');
      const poll = await findPoll(tx, identity.eventId, req.params.pollId); writable(poll);
      const participantId = identity.participantId; const pollId = poll.id;
      const prior = await tx.pollSubmission.findUnique({ where: { pollId_participantId_requestId: { pollId, participantId, requestId: requestId.toLowerCase() } } });
      const current = await ballot(tx, pollId, participantId);
      if (prior) {
        if (prior.payloadHash !== payloadHash) conflict('Request ID already used with different input');
        return { ballot: current, changed: false, replayed: true };
      }
      if (poll.version !== expectedPollVersion || current.version !== expectedVersion) conflict('Poll or vote changed; reload before voting');
      if ((poll.kind !== 'DATE' && selected.length !== 1) || selected.some(id => !poll.options.some(o => o.id === id))) bad('Invalid options for this poll');
      const changed = (current.version === 0 && !current.optionIds.length) || JSON.stringify(current.optionIds) !== JSON.stringify(selected);
      if (changed) {
        await tx.vote.deleteMany({ where: { pollId, participantId } });
        await tx.vote.createMany({ data: selected.map(optionId => ({ eventId: identity.eventId, pollId, participantId, optionId })) });
        await tx.pollBallot.upsert({ where: { pollId_participantId: { pollId, participantId } }, create: { eventId: identity.eventId, pollId, participantId, version: expectedVersion + 1 }, update: { version: expectedVersion + 1 } });
        await tx.auditEntry.create({ data: { eventId: identity.eventId, actorParticipantId: participantId, action: 'poll.vote', entityType: 'Poll', entityId: pollId } });
      }
      await tx.pollSubmission.create({ data: { eventId: identity.eventId, pollId, participantId, requestId: requestId.toLowerCase(), payloadHash } });
      return { ballot: changed ? { optionIds: selected, version: expectedVersion + 1 } : current, changed, replayed: false };
    }, true); res.json(result);
  }));
  return router;
}
