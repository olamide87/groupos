import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { createApp } from '../src/app.js';
import { hashToken } from '../src/auth/security.js';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^groupos_test_[a-f0-9]{32}$/.test(process.env.GROUPOS_TEST_DATABASE ?? '') || url.pathname !== `/${process.env.GROUPOS_TEST_DATABASE}`) throw new Error('Use disposable database runner');
const db = new PrismaClient(); const origin = 'http://polls.example.test';
const app = createApp({ database: () => db, settings: () => ({ origin, secureCookies: false, recoveryKey: Buffer.alloc(32) }) });
let server: ReturnType<typeof app.listen>; let base: string;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}/api/v1`; });
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.$disconnect(); });
async function request(method: string, path: string, cookie?: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(base + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', 'X-GroupOS-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: r.status === 204 ? null : await r.json() as any, headers: r.headers };
}
async function fixture() {
  const owner = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: 'Owner', passwordHash: 'synthetic-test-only' } });
  const auth = randomBytes(32).toString('hex');
  await db.authSession.create({ data: { userId: owner.id, tokenHash: hashToken(auth), authVersion: 0, expiresAt: new Date(Date.now() + 3600000) } });
  const event = await db.event.create({ data: { organizerId: owner.id, title: 'Poll outing', status: 'OPEN' } });
  const participant = await db.participant.create({ data: { eventId: event.id, displayName: 'Guest' } });
  const invitation = await db.invitationToken.create({ data: { eventId: event.id, participantId: participant.id, tokenHash: hashToken(randomUUID()), acceptedAt: new Date(), expiresAt: new Date(Date.now() + 3600000) } });
  const token = randomBytes(32).toString('hex');
  await db.participantSession.create({ data: { invitationId: invitation.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600000) } });
  return { owner, event, participant, invitation, cookie: `groupos_participant=${token}`, ownerCookie: `groupos_session=${auth}` };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const path = (f: Fixture) => `/events/${f.event.id}/polls`;
const participantPath = (f: Fixture) => `/participant/events/${f.event.id}/polls`;
const optionsFor = (kind: string) => [0, 1, 2].map(i => ({ label: `Choice ${i + 1}`, ...(kind === 'DATE' ? { startsAt: new Date(Date.now() + (i + 1) * 86400000).toISOString(), endsAt: new Date(Date.now() + (i + 1) * 86400000 + 3600000).toISOString() } : kind === 'BUDGET' ? { amountMinor: (i + 1) * 2500, currency: 'USD' } : {}) }));
async function create(f: Fixture, kind = 'ACTIVITY') { const result = await request('POST', path(f), f.ownerCookie, { question: 'Which option?', kind, options: optionsFor(kind) }); assert.equal(result.status, 201); return result.body.poll; }
const payload = (poll: any, optionIds = [poll.options[0].id], expectedVersion = 0, requestId = randomUUID()) => ({ optionIds, expectedVersion, expectedPollVersion: poll.version, requestId });
const vote = (f: Fixture, poll: any, body: unknown = payload(poll)) => request('POST', `${participantPath(f)}/${poll.id}/vote`, f.cookie, body);
const list = (f: Fixture) => request('GET', participantPath(f), f.cookie);

test('date multi-select, budget and activity preferences persist and return only own ballot', async () => {
  const f = await fixture();
  for (const kind of ['DATE', 'BUDGET', 'ACTIVITY']) {
    const poll = await create(f, kind); const ids = poll.options.slice(0, kind === 'DATE' ? 2 : 1).map((o: any) => o.id);
    const result = await vote(f, poll, payload(poll, ids)); assert.equal(result.status, 200); assert.equal(result.body.ballot.version, 1);
    assert.equal(await db.vote.count({ where: { pollId: poll.id } }), ids.length);
    assert.equal(await db.auditEntry.count({ where: { entityId: poll.id, actorParticipantId: f.participant.id, action: 'poll.vote' } }), 1);
  }
  const result = await list(f); assert.equal(result.body.polls.length, 3); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(result.body).includes('@example.test')); assert.ok(!JSON.stringify(result.body).includes('tokenHash'));
});

test('duplicate and late retries never duplicate or overwrite newer votes; unchanged votes are no-ops', async () => {
  const f = await fixture(); const poll = await create(f); const first = payload(poll);
  assert.equal((await vote(f, poll, first)).status, 200);
  const same = await vote(f, poll, payload(poll, first.optionIds, 1)); assert.equal(same.body.changed, false); assert.equal(same.body.ballot.version, 1);
  const next = await vote(f, poll, payload(poll, [poll.options[1].id], 1)); assert.equal(next.body.ballot.version, 2);
  const late = await vote(f, poll, first); assert.equal(late.body.replayed, true); assert.deepEqual(late.body.ballot, next.body.ballot);
  assert.equal(await db.vote.count({ where: { pollId: poll.id } }), 1);
  assert.equal(await db.auditEntry.count({ where: { entityId: poll.id, action: 'poll.vote' } }), 2);
  assert.equal((await vote(f, poll, { ...first, optionIds: [poll.options[2].id] })).status, 409);
  assert.equal((await vote(f, poll, payload(poll, [poll.options[2].id], 0))).status, 409);
});

test('concurrent identical ballots commit once and competing versioned votes have one winner', async () => {
  const f = await fixture(); const poll = await create(f, 'DATE'); const first = payload(poll);
  const retries = await Promise.all(Array.from({ length: 8 }, () => vote(f, poll, first)));
  assert.ok(retries.every(r => r.status === 200)); assert.equal(retries.filter(r => r.body.changed).length, 1);
  const edits = await Promise.all([vote(f, poll, payload(poll, [poll.options[1].id], 1)), vote(f, poll, payload(poll, [poll.options[2].id], 1))]);
  assert.deepEqual(edits.map(r => r.status).sort(), [200, 409]);
  assert.equal(await db.pollSubmission.count({ where: { pollId: poll.id } }), 2);
  assert.equal(await db.vote.count({ where: { pollId: poll.id } }), 1);
  assert.equal((await list(f)).body.polls[0].ballot.version, 2);
});

test('foreign, repeated, malformed and wrong-cardinality options have no side effects', async () => {
  const f = await fixture(); const poll = await create(f); const other = await create(f); const foreign = await create(await fixture());
  for (const ids of [[], [randomUUID()], [other.options[0].id], [foreign.options[0].id], [poll.options[0].id, poll.options[0].id], [poll.options[0].id, poll.options[1].id], ['invalid']]) assert.equal((await vote(f, poll, payload(poll, ids))).status, 400);
  for (const body of [{ ...payload(poll), participantId: f.participant.id }, { ...payload(poll), expectedVersion: -1 }, { ...payload(poll), expectedPollVersion: 0.5 }, { ...payload(poll), requestId: 'invalid' }]) assert.equal((await vote(f, poll, body)).status, 400);
  assert.equal(await db.vote.count({ where: { pollId: poll.id } }), 0); assert.equal(await db.pollSubmission.count({ where: { pollId: poll.id } }), 0);
});

test('owner editing is versioned, options freeze on first vote, and closure/cancellation retain results', async () => {
  const f = await fixture(); let poll = await create(f);
  const edited = await request('PATCH', `${path(f)}/${poll.id}`, f.ownerCookie, { expectedVersion: 0, question: 'Updated?', options: [{ label: 'Walk' }, { label: 'Museum' }] });
  assert.equal(edited.status, 200); assert.equal(edited.body.poll.version, 1);
  assert.equal((await vote(f, poll)).status, 409); poll = edited.body.poll;
  assert.equal((await vote(f, poll)).status, 200);
  assert.equal((await request('PATCH', `${path(f)}/${poll.id}`, f.ownerCookie, { expectedVersion: 1, options: optionsFor('ACTIVITY') })).status, 409);
  assert.equal((await request('PATCH', `${path(f)}/${poll.id}`, f.ownerCookie, { expectedVersion: 1, question: 'Which do you dislike?' })).status, 409);
  const closed = await request('POST', `${path(f)}/${poll.id}/close`, f.ownerCookie, { expectedVersion: 1 }); assert.equal(closed.status, 200);
  assert.equal((await vote(f, poll)).status, 409); assert.equal((await list(f)).body.polls[0].canVote, false);
  assert.equal((await request('POST', `${path(f)}/${poll.id}/cancel`, f.ownerCookie, { expectedVersion: 2 })).status, 200);
  assert.equal((await request('POST', `${path(f)}/${poll.id}/close`, f.ownerCookie, { expectedVersion: 3 })).status, 409);
  assert.equal((await request('PATCH', `${path(f)}/${poll.id}`, f.ownerCookie, { expectedVersion: 3, question: 'Reopen?' })).status, 409);
  assert.equal(await db.vote.count({ where: { pollId: poll.id } }), 1);
});

test('authentication and ownership prevent cross-event reads, votes, edits and results access', async () => {
  const f = await fixture(); const other = await fixture(); const poll = await create(f); const foreign = await create(other);
  for (const cookie of [undefined, other.cookie, f.ownerCookie, `${f.cookie}; ${f.cookie}`]) {
    assert.equal((await request('GET', participantPath(f), cookie)).status, 404);
    assert.equal((await request('POST', `${participantPath(f)}/${poll.id}/vote`, cookie, payload(poll))).status, 404);
  }
  assert.equal((await vote(f, foreign)).status, 404);
  for (const cookie of [undefined, f.cookie, other.ownerCookie]) {
    const status = cookie === other.ownerCookie ? 404 : 401;
    for (const [method, suffix, body] of [['GET', '', undefined], ['GET', `/${poll.id}/results`, undefined], ['PATCH', `/${poll.id}`, { question: 'Forged', expectedVersion: 0 }], ['POST', `/${poll.id}/close`, { expectedVersion: 0 }], ['POST', `/${poll.id}/cancel`, { expectedVersion: 0 }]] as const) assert.equal((await request(method, path(f) + suffix, cookie, body)).status, status);
  }
  assert.equal((await request('GET', `${path(f)}/${foreign.id}/results`, f.ownerCookie)).status, 404);
});

test('expired sessions/invitations and revoked invitations cannot read or vote', async () => {
  for (const kind of ['session', 'invitation', 'revoked']) {
    const f = await fixture(); const poll = await create(f);
    if (kind === 'session') await db.participantSession.update({ where: { invitationId: f.invitation.id }, data: { expiresAt: new Date(0) } });
    else await db.invitationToken.update({ where: { id: f.invitation.id }, data: kind === 'revoked' ? { revokedAt: new Date() } : { createdAt: new Date(0), expiresAt: new Date(1000) } });
    assert.equal((await list(f)).status, 404); assert.equal((await vote(f, poll)).status, 404);
  }
});

test('deadline, cancelled poll and draft/finalized/cancelled event deny votes', async () => {
  for (const mode of ['deadline', 'poll', 'DRAFT', 'FINALIZED', 'CANCELLED']) {
    const f = await fixture(); const poll = await create(f);
    if (mode === 'deadline') await db.poll.update({ where: { id: poll.id }, data: { closesAt: new Date(0) } });
    else if (mode === 'poll') await request('POST', `${path(f)}/${poll.id}/cancel`, f.ownerCookie, { expectedVersion: 0 });
    else await db.event.update({ where: { id: f.event.id }, data: { status: mode as 'DRAFT' | 'FINALIZED' | 'CANCELLED' } });
    assert.equal((await vote(f, poll)).status, ['DRAFT', 'CANCELLED'].includes(mode) ? 404 : 409);
    assert.equal(await db.vote.count({ where: { pollId: poll.id } }), 0);
  }
});

test('closure, cancellation and invitation revocation races serialize with voting', async () => {
  for (const mode of ['close', 'poll-cancel', 'event-cancel', 'revoke']) {
    const f = await fixture(); const poll = await create(f);
    const endpoint = mode === 'close' ? `${path(f)}/${poll.id}/close` : mode === 'poll-cancel' ? `${path(f)}/${poll.id}/cancel` : mode === 'event-cancel' ? `/events/${f.event.id}/cancel` : `/events/${f.event.id}/invitations/${f.invitation.id}/revoke`;
    const [voted, stopped] = await Promise.all([vote(f, poll), request('POST', endpoint, f.ownerCookie, mode === 'close' || mode === 'poll-cancel' ? { expectedVersion: 0 } : {})]);
    assert.ok([200, 204].includes(stopped.status)); assert.ok([200, 404, 409].includes(voted.status));
    assert.ok([404, 409].includes((await vote(f, poll)).status));
    const expected = voted.status === 200 ? 1 : 0;
    assert.equal(await db.vote.count({ where: { pollId: poll.id } }), expected);
    assert.equal(await db.pollSubmission.count({ where: { pollId: poll.id } }), expected);
    assert.equal(await db.auditEntry.count({ where: { entityId: poll.id, action: 'poll.vote' } }), expected);
  }
});

test('aggregate counts distinguish respondents from date selections and never expose identities', async () => {
  const f = await fixture(); const poll = await create(f, 'DATE'); await vote(f, poll, payload(poll, poll.options.map((o: any) => o.id)));
  await db.participant.create({ data: { eventId: f.event.id, displayName: 'Pending', email: 'private@example.test' } });
  const result = await request('GET', `${path(f)}/${poll.id}/results`, f.ownerCookie);
  assert.equal(result.status, 200); assert.equal(result.body.responded, 1); assert.equal(result.body.pending, 1); assert.equal(result.body.total, 2);
  assert.deepEqual(result.body.counts.map((c: any) => c.count), [1, 1, 1]);
  assert.ok(!JSON.stringify(result.body).includes(f.participant.id)); assert.ok(!JSON.stringify(result.body).includes('private@example.test'));
});

test('strict creation validation rejects unsafe dates, budgets, nested input and unsupported fields', async () => {
  const f = await fixture(); const valid = { question: 'Question?', kind: 'ACTIVITY', options: optionsFor('ACTIVITY') };
  for (const body of [{ ...valid, organizerId: f.owner.id }, { ...valid, kind: 'OTHER' }, { ...valid, question: '' }, { ...valid, options: [] }, { ...valid, options: [{ label: 'same' }, { label: 'Same' }] }, { ...valid, closesAt: '2020-01-01T00:00:00Z' }, { ...valid, kind: 'DATE', options: [{ label: 'One', startsAt: '2030-02-30T00:00:00Z', endsAt: '2030-03-02T00:00:00Z' }, optionsFor('DATE')[1]] }, { ...valid, kind: 'BUDGET', options: [{ label: 'One', amountMinor: -1, currency: 'USD' }, optionsFor('BUDGET')[1]] }, { ...valid, kind: 'BUDGET', options: [{ label: 'One', amountMinor: 100, currency: 'GBP' }, optionsFor('BUDGET')[1]] }]) assert.equal((await request('POST', path(f), f.ownerCookie, body)).status, 400);
  assert.equal(await db.poll.count({ where: { eventId: f.event.id } }), 0);
});

test('all poll writes require CSRF protections and lists enforce pagination', async () => {
  const f = await fixture(); const poll = await create(f);
  for (const headers of [{ Origin: '' }, { Origin: 'https://evil.example.test' }, { 'X-GroupOS-Request': '' }, { 'Content-Type': 'text/plain' }] as Record<string, string>[]) {
    for (const [method, endpoint, cookie, body] of [['POST', path(f), f.ownerCookie, { kind: 'ACTIVITY', question: 'Q', options: optionsFor('ACTIVITY') }], ['PATCH', `${path(f)}/${poll.id}`, f.ownerCookie, { expectedVersion: 0, question: 'Q' }], ['POST', `${path(f)}/${poll.id}/close`, f.ownerCookie, { expectedVersion: 0 }], ['POST', `${path(f)}/${poll.id}/cancel`, f.ownerCookie, { expectedVersion: 0 }], ['POST', `${participantPath(f)}/${poll.id}/vote`, f.cookie, payload(poll)]] as const) assert.equal((await request(method, endpoint, cookie, body, headers)).status, 403);
  }
  for (const query of ['?offset=-1', '?offset=10001', '?offset=0&offset=1', '?participantId=forged']) {
    assert.equal((await request('GET', participantPath(f) + query, f.cookie)).status, 400);
    assert.equal((await request('GET', path(f) + query, f.ownerCookie)).status, 400);
  }
});

test('a failed vote audit insert rolls back selection replacement, version and request ledger', async () => {
  const f = await fixture(); const poll = await create(f); await vote(f, poll);
  // A transaction-local trigger fails only this poll's audit inserts, in this disposable database.
  await db.$executeRawUnsafe(`CREATE FUNCTION fail_poll_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."entityId" = '${poll.id}'::uuid AND NEW.action = 'poll.vote' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER fail_poll_audit BEFORE INSERT ON "AuditEntry" FOR EACH ROW EXECUTE FUNCTION fail_poll_audit()');
  try {
    const result = await vote(f, poll, payload(poll, [poll.options[1].id], 1)); assert.equal(result.status, 500); assert.deepEqual(result.body, { error: 'Request could not be completed' });
    assert.deepEqual((await list(f)).body.polls[0].ballot, { version: 1, optionIds: [poll.options[0].id] });
    assert.equal(await db.pollSubmission.count({ where: { pollId: poll.id } }), 1);
  } finally { await db.$executeRawUnsafe('DROP TRIGGER fail_poll_audit ON "AuditEntry"'); await db.$executeRawUnsafe('DROP FUNCTION fail_poll_audit()'); }
});

test('none-available date ballots count as responses, freeze options and support later updates', async () => {
  const f = await fixture(); const poll = await create(f, 'DATE');
  const empty = await vote(f, poll, payload(poll, [])); assert.equal(empty.status, 200); assert.equal(empty.body.ballot.version, 1);
  const results = await request('GET', `${path(f)}/${poll.id}/results`, f.ownerCookie);
  assert.equal(results.body.responded, 1); assert.equal(results.body.pending, 0); assert.ok(results.body.counts.every((c: any) => c.count === 0));
  assert.equal((await vote(f, poll, payload(poll, [], 1))).body.changed, false);
  assert.equal((await request('PATCH', `${path(f)}/${poll.id}`, f.ownerCookie, { expectedVersion: 0, options: optionsFor('DATE') })).status, 409);
  assert.equal((await vote(f, poll, payload(poll, [poll.options[0].id], 1))).body.ballot.version, 2);
});

test('option replacement racing with voting either precedes the vote or is rejected without partial edits', async () => {
  const f = await fixture(); const poll = await create(f);
  const [voted, edited] = await Promise.all([vote(f, poll), request('PATCH', `${path(f)}/${poll.id}`, f.ownerCookie, { expectedVersion: 0, options: [{ label: 'New A' }, { label: 'New B' }] })]);
  assert.deepEqual([voted.status, edited.status].sort(), [200, 409]);
  const current = (await list(f)).body.polls[0];
  if (voted.status === 200) { assert.equal(current.version, 0); assert.deepEqual(current.ballot.optionIds, [poll.options[0].id]); }
  else { assert.equal(current.version, 1); assert.equal(current.ballot.version, 0); assert.equal(current.options.length, 2); }
});

test('database keys reject cross-event ballots, ledgers and participant audit actors', async () => {
  const f = await fixture(); const other = await fixture(); const poll = await create(f);
  const rejectsForeignKey = (promise: Promise<unknown>) => assert.rejects(promise, (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003');
  await rejectsForeignKey(db.pollBallot.create({ data: { eventId: f.event.id, pollId: poll.id, participantId: other.participant.id } }));
  await rejectsForeignKey(db.pollSubmission.create({ data: { eventId: other.event.id, pollId: poll.id, participantId: other.participant.id, requestId: randomUUID(), payloadHash: 'a'.repeat(64) } }));
  await rejectsForeignKey(db.auditEntry.create({ data: { eventId: f.event.id, actorParticipantId: other.participant.id, entityType: 'Poll', entityId: poll.id, action: 'poll.vote' } }));
});

test('session expiry is rechecked after waiting for the event write lock', async () => {
  const f = await fixture(); const poll = await create(f);
  let release!: () => void; let locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const blocker = db.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${f.event.id}::uuid FOR UPDATE`; locked(); await gate; }, { timeout: 10000 });
  await ready;
  try {
    const pending = vote(f, poll);
    await new Promise(resolve => setTimeout(resolve, 100));
    await db.participantSession.update({ where: { invitationId: f.invitation.id }, data: { expiresAt: new Date(0) } });
    release(); await blocker;
    assert.equal((await pending).status, 404); assert.equal(await db.vote.count({ where: { pollId: poll.id } }), 0);
  } finally { release(); await blocker; }
});
