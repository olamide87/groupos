import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { connectDatabase, disconnectDatabase, getDatabase } from '../src/database.js';

const url = new URL(process.env.DATABASE_URL ?? '');
const name = process.env.GROUPOS_TEST_DATABASE;
if (!name || !/^groupos_test_[a-f0-9]{32}$/.test(name) || url.pathname !== `/${name}`) {
  throw new Error('Use npm run test:db; integration tests require a newly created disposable database');
}
const db = new PrismaClient();
before(() => db.$connect());
after(async () => { await disconnectDatabase(); await db.$disconnect(); });

async function fixture() {
  const organizer = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: 'Organizer' } });
  const event = await db.event.create({ data: { organizerId: organizer.id, title: 'Outing' } });
  const participant = await db.participant.create({ data: { eventId: event.id, displayName: 'Guest', email: `${randomUUID()}@example.test` } });
  const poll = await db.poll.create({ data: { eventId: event.id, question: 'Activity?', kind: 'ACTIVITY', options: { create: { label: 'Walk', position: 0 } } }, include: { options: true } });
  return { organizer, event, participant, poll, option: poll.options[0] };
}
const rejectsCode = (promise: Promise<unknown>, code: string) => assert.rejects(promise,
  (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === code);

test('migration chain applies once, preserves pre-auth data and creates all domain tables', async () => {
  const rows = await db.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
    SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL`;
  assert.deepEqual(rows.map(row => row.migration_name).sort(), ['20261114000000_initial', '20261114010000_organizer_auth', '20261115020000_participant_sessions', '20261115030000_rsvp_history']);
  assert.ok(rows.every(row => row.finished_at));
  const legacy = await db.user.findFirstOrThrow({ where: { email: { startsWith: 'legacy-groupos_test_' } }, include: { events: true } });
  assert.equal(legacy.passwordHash, null);
  assert.equal(legacy.authVersion, 0);
  assert.equal(legacy.events[0].title, 'Pre-auth event');
  const legacyInvitation = await db.invitationToken.findFirstOrThrow({ where: { eventId: legacy.events[0].id } });
  assert.equal(legacyInvitation.acceptedAt, null);
  const legacyRsvp = await db.rsvp.findUniqueOrThrow({ where: { participantId: legacyInvitation.participantId! } });
  assert.equal(legacyRsvp.response, 'MAYBE'); assert.equal(legacyRsvp.version, 0);
  const legacyHistory = await db.rsvpHistory.findFirstOrThrow({ where: { participantId: legacyInvitation.participantId! } });
  assert.equal(legacyHistory.response, 'MAYBE'); assert.equal(legacyHistory.revision, null);
  assert.equal(await db.participantSession.count({ where: { invitationId: legacyInvitation.id } }), 0);
  for (const model of [db.user, db.event, db.participant, db.invitationToken, db.rsvp,
    db.rsvpHistory, db.poll, db.pollOption, db.vote, db.recommendation, db.notificationConsent, db.auditEntry,
    db.authSession, db.passwordReset, db.recoveryMessage, db.authRateLimit, db.participantSession, db.rsvpSubmission]) {
    assert.equal(typeof await (model.count as () => Promise<number>)(), 'number');
  }
});

test('creates and reads an organizer-owned event with RSVP history, recommendation, consent and audit', async () => {
  const f = await fixture();
  await db.$transaction(async (tx) => {
    await tx.rsvp.create({ data: { participantId: f.participant.id, response: 'MAYBE' } });
    await tx.rsvpHistory.create({ data: { participantId: f.participant.id, response: 'MAYBE' } });
    await tx.rsvp.update({ where: { participantId: f.participant.id }, data: { response: 'YES' } });
    await tx.rsvpHistory.create({ data: { participantId: f.participant.id, response: 'YES' } });
    await tx.notificationConsent.create({ data: { participantId: f.participant.id, source: 'invitation-form' } });
    await tx.recommendation.create({ data: { eventId: f.event.id, source: 'AI', summary: 'Consider a walk', rationale: 'Shared preference' } });
    await tx.auditEntry.create({ data: { eventId: f.event.id, actorUserId: f.organizer.id, action: 'event.created', entityType: 'Event', entityId: f.event.id } });
  });
  const event = await db.event.findUniqueOrThrow({ where: { id: f.event.id }, include: {
    organizer: true, participants: { include: { rsvp: true, rsvpHistory: true, consents: true } }, recommendations: true, audit: true,
  } });
  assert.equal(event.organizer.id, f.organizer.id);
  assert.equal(event.participants[0].rsvp?.response, 'YES');
  assert.equal(event.participants[0].rsvpHistory.length, 2);
  assert.equal(event.participants[0].consents[0].status, 'OPTED_OUT');
  assert.equal(event.recommendations[0].status, 'PENDING');
  assert.equal(event.audit.length, 1);
});

test('rejects orphan events and deletion of an organizer with events', async () => {
  const f = await fixture();
  await rejectsCode(db.event.create({ data: { organizerId: randomUUID(), title: 'Orphan' } }), 'P2003');
  await rejectsCode(db.user.delete({ where: { id: f.organizer.id } }), 'P2003');
  await rejectsCode(db.event.delete({ where: { id: f.event.id } }), 'P2003');
});

test('enforces unique email, event membership, current RSVP and channel consent', async () => {
  const f = await fixture();
  await rejectsCode(db.user.create({ data: { email: f.organizer.email, name: 'Duplicate' } }), 'P2002');
  await rejectsCode(db.participant.create({ data: { eventId: f.event.id, email: f.participant.email, displayName: 'Duplicate' } }), 'P2002');
  await db.rsvp.create({ data: { participantId: f.participant.id, response: 'YES' } });
  await rejectsCode(db.rsvp.create({ data: { participantId: f.participant.id, response: 'NO' } }), 'P2002');
  await db.notificationConsent.create({ data: { participantId: f.participant.id, source: 'form' } });
  await rejectsCode(db.notificationConsent.create({ data: { participantId: f.participant.id, source: 'form' } }), 'P2002');
});

test('persists hashed invitations with expiry and revocation; rejects duplicate and cross-event tokens', async () => {
  const f = await fixture();
  const other = await fixture();
  const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
  const data = { eventId: f.event.id, participantId: f.participant.id, tokenHash, expiresAt: new Date(Date.now() + 60_000) };
  const token = await db.invitationToken.create({ data });
  await rejectsCode(db.invitationToken.create({ data }), 'P2002');
  await rejectsCode(db.invitationToken.create({ data: { ...data, tokenHash: 'a'.repeat(64), participantId: other.participant.id } }), 'P2003');
  const revoked = await db.invitationToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } });
  assert.ok(revoked.revokedAt);
  assert.equal(await db.invitationToken.count({ where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } } }), 0);
});

test('accepts a vote and prevents duplicate votes, cross-event voters and options from another poll', async () => {
  const f = await fixture();
  const other = await fixture();
  const data = { eventId: f.event.id, pollId: f.poll.id, participantId: f.participant.id, optionId: f.option.id };
  await db.vote.create({ data });
  await rejectsCode(db.vote.create({ data }), 'P2002');
  await rejectsCode(db.vote.create({ data: { ...data, participantId: other.participant.id } }), 'P2003');
  await rejectsCode(db.vote.update({ where: { pollId_participantId: { pollId: f.poll.id, participantId: f.participant.id } }, data: { optionId: other.option.id } }), 'P2003');
  assert.equal(await db.vote.count({ where: { pollId: f.poll.id } }), 1);
});

test('database checks reject malformed hashes, impossible dates, negative positions and non-normalized email', async () => {
  const f = await fixture();
  await assert.rejects(db.invitationToken.create({ data: { eventId: f.event.id, tokenHash: 'raw-token', expiresAt: new Date(Date.now() + 60_000) } }));
  await assert.rejects(db.invitationToken.create({ data: { eventId: f.event.id, tokenHash: 'b'.repeat(64), expiresAt: new Date(0) } }));
  await assert.rejects(db.event.update({ where: { id: f.event.id }, data: { startsAt: new Date(2000), endsAt: new Date(1000) } }));
  await assert.rejects(db.pollOption.create({ data: { pollId: f.poll.id, label: 'Invalid', position: -1 } }));
  await assert.rejects(db.user.create({ data: { email: 'UPPER@example.test', name: 'Invalid' } }));
});

test('rolls back RSVP and history together if any write fails', async () => {
  const f = await fixture();
  await assert.rejects(db.$transaction(async (tx) => {
    await tx.rsvp.create({ data: { participantId: f.participant.id, response: 'YES' } });
    await tx.rsvpHistory.create({ data: { participantId: randomUUID(), response: 'YES' } });
  }));
  assert.equal(await db.rsvp.count({ where: { participantId: f.participant.id } }), 0);
});

test('database client reuses its pool and reconnects after shutdown', async () => {
  await connectDatabase();
  const first = getDatabase();
  assert.equal(first, getDatabase());
  await first.$queryRaw`SELECT 1`;
  await disconnectDatabase();
  await disconnectDatabase();
  await connectDatabase();
  assert.notEqual(first, getDatabase());
  await getDatabase().$queryRaw`SELECT 1`;
});
