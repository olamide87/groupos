import { Router, type Request, type Response, type RequestHandler } from 'express';
import { type Prisma, type PrismaClient } from '@prisma/client';
import { requireOrganizer, type AuthOptions } from './auth/routes.js';
import { requireSameOrigin } from './auth/csrf.js';
import { AuthError, hashToken, newToken, readAuthSettings, validToken, type AuthSettings } from './auth/security.js';
import { consumeRateLimit } from './auth/rate-limit.js';
import { getDatabase } from './database.js';
import { clientIp } from './proxy.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => new AuthError(404, 'Invitation or participant access is unavailable');
const cookieName = (s: AuthSettings) => s.secureCookies ? '__Host-groupos_participant' : 'groupos_participant';
const cookieOptions = (s: AuthSettings) => ({ httpOnly: true, secure: s.secureCookies, sameSite: 'strict' as const, path: '/' });
const metadata = { id: true, participantId: true, expiresAt: true, revokedAt: true, acceptedAt: true, createdAt: true } as const;
const action = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next) => { fn(req, res).catch(next); };
const headers: RequestHandler = (_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); };
function participantToken(req: Request, settings: AuthSettings) {
  const values = (req.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${cookieName(settings)}=`));
  if (values.length !== 1) return;
  const token = values[0].slice(cookieName(settings).length + 1);
  return validToken(token) ? token : undefined;
}
async function ownedEvent(tx: Prisma.TransactionClient, id: string, organizerId: string) {
  if (!uuid.test(id)) throw new AuthError(404, 'Event not found');
  // Same lock order as cancellation, issuance, revocation and acceptance.
  await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${id}::uuid AND "organizerId" = ${organizerId}::uuid FOR UPDATE`;
  const event = await tx.event.findFirst({ where: { id, organizerId } });
  if (!event) throw new AuthError(404, 'Event not found');
  return event;
}

export function createOrganizerInvitationsRouter(options: AuthOptions = {}) {
  const router = Router(); const database = options.database ?? getDatabase; const settings = options.settings ?? readAuthSettings;
  router.use(headers, requireOrganizer(options), requireSameOrigin(settings));
  router.post('/:eventId/invitations', action(async (req, res) => {
    const { participantId, displayName, expiresInHours = 72 } = req.body;
    if (Object.keys(req.body).some(k => !['participantId', 'displayName', 'expiresInHours'].includes(k))
      || !Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168
      || (participantId === undefined ? typeof displayName !== 'string' || !displayName.trim() || displayName.length > 120
        : typeof participantId !== 'string' || !uuid.test(participantId) || displayName !== undefined)) throw new AuthError(400, 'Invalid invitation input');
    const db = database(); const organizerId = res.locals.organizer.id as string;
    await consumeRateLimit(db, 'invitation.issue', clientIp(req), organizerId,
      options.policies?.invitationIssue ?? { ip: 100, account: 60, windowMs: 3600000 });
    const raw = newToken(); const config = settings();
    const result = await db.$transaction(async tx => {
      const event = await ownedEvent(tx, req.params.eventId, organizerId);
      if (event.status !== 'OPEN') throw new AuthError(409, 'Only open events can issue invitations');
      const participant = participantId === undefined
        ? await tx.participant.create({ data: { eventId: event.id, displayName: displayName.trim() } })
        : await tx.participant.findFirst({ where: { id: participantId, eventId: event.id } });
      if (!participant) throw new AuthError(404, 'Participant not found');
      // Reissue invalidates previous links AND sessions for this participant.
      await tx.invitationToken.updateMany({ where: { eventId: event.id, participantId: participant.id, revokedAt: null }, data: { revokedAt: new Date() } });
      const invitation = await tx.invitationToken.create({ data: { eventId: event.id, participantId: participant.id,
        tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + expiresInHours * 3600000) }, select: metadata });
      await tx.auditEntry.create({ data: { eventId: event.id, actorUserId: organizerId, action: 'invitation.issue', entityType: 'InvitationToken', entityId: invitation.id } });
      return invitation;
    });
    res.status(201).json({ invitation: result, invitationUrl: `${config.origin}/invite#event=${req.params.eventId.toLowerCase()}&token=${raw}` });
  }));
  router.get('/:eventId/invitations', action(async (req, res) => {
    const organizerId = res.locals.organizer.id as string;
    const invitations = await database().$transaction(async tx => {
      await ownedEvent(tx, req.params.eventId, organizerId);
      return tx.invitationToken.findMany({ where: { eventId: req.params.eventId }, select: metadata,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
    });
    res.json({ invitations });
  }));
  router.post('/:eventId/invitations/:invitationId/revoke', action(async (req, res) => {
    if (Object.keys(req.body).length) throw new AuthError(400, 'Use an empty JSON object');
    const organizerId = res.locals.organizer.id as string;
    await database().$transaction(async tx => {
      await ownedEvent(tx, req.params.eventId, organizerId);
      if (!uuid.test(req.params.invitationId)) throw new AuthError(404, 'Invitation not found');
      const invitation = await tx.invitationToken.findFirst({ where: { id: req.params.invitationId, eventId: req.params.eventId } });
      if (!invitation) throw new AuthError(404, 'Invitation not found');
      if (invitation.revokedAt) return;
      await tx.invitationToken.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
      await tx.auditEntry.create({ data: { eventId: invitation.eventId, actorUserId: organizerId, action: 'invitation.revoke', entityType: 'InvitationToken', entityId: invitation.id } });
    });
    res.status(204).end();
  }));
  return router;
}

// Shared participant authorization boundary for future RSVP/poll handlers. Execute
// participant operations inside this transaction, holding the event lock throughout.
export async function withParticipant<T>(req: Request, db: PrismaClient, settings: AuthSettings,
  operation: (tx: Prisma.TransactionClient, identity: { eventId: string; participantId: string }) => Promise<T>, write = false): Promise<T> {
  const token = participantToken(req, settings); const eventId = req.params.eventId.toLowerCase();
  if (!token || !uuid.test(eventId)) throw unavailable();
  return db.$transaction(async tx => {
    if (write) await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId}::uuid FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId}::uuid FOR SHARE`;
    const session = await tx.participantSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { invitation: { include: { event: true } } } });
    const invitation = session?.invitation; const now = new Date();
    if (!session || session.expiresAt <= now || !invitation || invitation.eventId !== eventId || !invitation.participantId
      || !invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now
      || !['OPEN', 'FINALIZED'].includes(invitation.event.status)) throw unavailable();
    return operation(tx, { eventId, participantId: invitation.participantId });
  });
}

export function createParticipantRouter(options: AuthOptions = {}) {
  const router = Router(); const database = options.database ?? getDatabase; const settings = options.settings ?? readAuthSettings;
  router.use(headers, requireSameOrigin(settings));
  router.post('/events/:eventId/accept', action(async (req, res) => {
    const db = database(); const token = req.body.token; const eventId = req.params.eventId.toLowerCase();
    await consumeRateLimit(db, 'invitation.accept', clientIp(req), validToken(token) ? hashToken(token) : '(invalid)',
      options.policies?.invitationAccept ?? { ip: 30, account: 10, windowMs: 900000 });
    if (Object.keys(req.body).some(k => k !== 'token') || !validToken(token) || !uuid.test(eventId)) throw unavailable();
    const rawSession = newToken(); const config = settings();
    const expiresAt = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId}::uuid FOR UPDATE`;
      const invitation = await tx.invitationToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { event: true } });
      const now = new Date();
      if (!invitation || invitation.eventId !== eventId || !invitation.participantId || invitation.revokedAt || invitation.acceptedAt
        || invitation.expiresAt <= now || invitation.event.status !== 'OPEN') throw unavailable();
      const claimed = await tx.invitationToken.updateMany({ where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { acceptedAt: now } });
      if (claimed.count !== 1) throw unavailable();
      const expiresAt = new Date(Math.min(now.getTime() + 3600000, invitation.expiresAt.getTime()));
      await tx.participantSession.deleteMany({ where: { expiresAt: { lte: now } } });
      await tx.participantSession.create({ data: { tokenHash: hashToken(rawSession), invitationId: invitation.id, expiresAt } });
      await tx.auditEntry.create({ data: { eventId, action: 'invitation.accept', entityType: 'InvitationToken', entityId: invitation.id } });
      return expiresAt;
    });
    res.cookie(cookieName(config), rawSession, { ...cookieOptions(config), expires: expiresAt });
    res.json({ eventId, expiresAt });
  }));
  router.get('/events/:eventId', action(async (req, res) => {
    const result = await withParticipant(req, database(), settings(), async (tx, identity) => {
      const event = await tx.event.findUniqueOrThrow({ where: { id: identity.eventId }, select: { id: true, title: true, description: true,
        location: true, startsAt: true, endsAt: true, timeZone: true, status: true } });
      const participant = await tx.participant.findFirstOrThrow({ where: { id: identity.participantId, eventId: identity.eventId }, select: { id: true, displayName: true } });
      return { event, participant };
    });
    res.json(result);
  }));
  return router;
}
