import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { createApp } from '../src/app.js';
import { hashToken } from '../src/auth/security.js';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^groupos_test_[a-f0-9]{32}$/.test(process.env.GROUPOS_TEST_DATABASE ?? '') || url.pathname !== `/${process.env.GROUPOS_TEST_DATABASE}`) throw new Error('Use disposable database runner');
const db = new PrismaClient(); const origin = 'http://rsvp.example.test';
const app = createApp({ database: () => db, settings: () => ({ origin, secureCookies: false, recoveryKey: Buffer.alloc(32) }) });
let server: ReturnType<typeof app.listen>; let base: string;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}/api/v1`; });
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.$disconnect(); });
async function request(method: string, path: string, cookie?: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(base + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', 'X-GroupOS-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: r.status === 204 ? null : await r.json() as any, headers: r.headers };
}
async function fixture() {
  const owner = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: 'Owner', passwordHash: 'synthetic' } });
  const auth = randomBytes(32).toString('hex');
  await db.authSession.create({ data: { userId: owner.id, tokenHash: hashToken(auth), authVersion: 0, expiresAt: new Date(Date.now() + 3600000) } });
  const event = await db.event.create({ data: { organizerId: owner.id, title: 'RSVP outing', status: 'OPEN' } });
  const participant = await db.participant.create({ data: { eventId: event.id, displayName: 'Guest' } });
  const invitation = await db.invitationToken.create({ data: { eventId: event.id, participantId: participant.id, tokenHash: hashToken(randomUUID()), acceptedAt: new Date(), expiresAt: new Date(Date.now() + 3600000) } });
  const token = randomBytes(32).toString('hex');
  await db.participantSession.create({ data: { invitationId: invitation.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600000) } });
  return { owner, event, participant, invitation, token, cookie: `groupos_participant=${token}`, ownerCookie: `groupos_session=${auth}` };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const payload = (response = 'YES', expectedVersion = 0, requestId = randomUUID()) => ({ response, expectedVersion, requestId });
const submit = (f: Fixture, body = payload()) => request('POST', `/participant/events/${f.event.id}/rsvp`, f.cookie, body);
const read = (f: Fixture) => request('GET', `/participant/events/${f.event.id}/rsvp`, f.cookie);
const history = (f: Fixture) => request('GET', `/participant/events/${f.event.id}/rsvp/history`, f.cookie);

test('YES, NO and MAYBE update current response and retain an ordered immutable history', async () => {
  const f = await fixture(); assert.deepEqual((await read(f)).body.rsvp, { response: null, version: 0, updatedAt: null });
  for (const [version, choice] of ['YES', 'NO', 'MAYBE'].entries()) {
    const r = await submit(f, payload(choice, version)); assert.equal(r.status, 200); assert.equal(r.body.rsvp.version, version + 1); assert.equal(r.body.changed, true);
  }
  const rows = (await history(f)).body.history;
  assert.deepEqual(rows.map((r: any) => r.response), ['YES', 'NO', 'MAYBE']); assert.deepEqual(rows.map((r: any) => r.revision), [1, 2, 3]);
  assert.equal((await read(f)).body.rsvp.response, 'MAYBE');
  assert.equal(await db.auditEntry.count({ where: { entityId: f.participant.id, action: 'rsvp.change' } }), 3);
  await assert.rejects(db.rsvpHistory.create({ data: { participantId: f.participant.id, response: 'YES', revision: 3 } }), (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002');
});

test('duplicate retries do not append history or revert a newer response', async () => {
  const f = await fixture(); const first = payload();
  await submit(f, first); const replay = await submit(f, first); assert.equal(replay.body.replayed, true);
  await submit(f, payload('NO', 1));
  const late = await submit(f, first); assert.equal(late.status, 200); assert.equal(late.body.rsvp.response, 'NO'); assert.equal(late.body.rsvp.version, 2);
  assert.equal(await db.rsvpHistory.count({ where: { participantId: f.participant.id } }), 2);
  assert.equal(await db.rsvpSubmission.count({ where: { participantId: f.participant.id } }), 2);
});

test('request ID reuse with different input and stale edits fail without side effects', async () => {
  const f = await fixture(); const first = payload(); await submit(f, first);
  assert.equal((await submit(f, { ...first, response: 'NO' })).status, 409);
  assert.equal((await submit(f, { ...first, expectedVersion: 1 })).status, 409);
  assert.equal((await submit(f, payload('MAYBE', 0))).status, 409);
  assert.equal((await read(f)).body.rsvp.response, 'YES');
  assert.equal(await db.rsvpSubmission.count({ where: { participantId: f.participant.id } }), 1);
  assert.equal(await db.rsvpHistory.count({ where: { participantId: f.participant.id } }), 1);
});

test('a new request for the unchanged response preserves version, timestamp and history', async () => {
  const f = await fixture(); const first = await submit(f); const same = await submit(f, payload('YES', 1));
  assert.equal(same.status, 200); assert.equal(same.body.changed, false); assert.deepEqual(same.body.rsvp, first.body.rsvp);
  assert.equal(await db.rsvpHistory.count({ where: { participantId: f.participant.id } }), 1);
});

test('a failed history insert rolls back current state, deduplication and audit together', async () => {
  const f = await fixture();
  // Inject a conflicting revision to force a database failure after the current-row write.
  await db.rsvpHistory.create({ data: { participantId: f.participant.id, response: 'NO', revision: 1 } });
  const result = await submit(f); assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: 'Request could not be completed' });
  assert.equal(await db.rsvp.count({ where: { participantId: f.participant.id } }), 0);
  assert.equal(await db.rsvpSubmission.count({ where: { participantId: f.participant.id } }), 0);
  assert.equal(await db.auditEntry.count({ where: { entityId: f.participant.id } }), 0);
  assert.equal((await db.rsvpHistory.findFirstOrThrow({ where: { participantId: f.participant.id } })).response, 'NO');
});

test('concurrent duplicate requests commit one current row, history entry and request ledger entry', async () => {
  const f = await fixture(); const body = payload(); const results = await Promise.all(Array.from({ length: 8 }, () => submit(f, body)));
  assert.ok(results.every(r => r.status === 200)); assert.equal(results.filter(r => r.body.changed).length, 1);
  assert.equal(await db.rsvp.count({ where: { participantId: f.participant.id } }), 1);
  assert.equal(await db.rsvpHistory.count({ where: { participantId: f.participant.id } }), 1);
  assert.equal(await db.rsvpSubmission.count({ where: { participantId: f.participant.id } }), 1);
});

test('competing edits from the same version produce one winner and a coherent history', async () => {
  const f = await fixture(); await submit(f);
  const results = await Promise.all([submit(f, payload('NO', 1)), submit(f, payload('MAYBE', 1))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const current = (await read(f)).body.rsvp; const rows = (await history(f)).body.history;
  assert.equal(current.version, 2); assert.equal(rows.length, 2); assert.equal(rows[1].response, current.response); assert.equal(rows[1].revision, 2);
});

test('participant access cannot cross events, impersonate another participant or use organizer credentials', async () => {
  const f = await fixture(); const other = await fixture();
  for (const cookie of [undefined, other.cookie, f.ownerCookie, `${f.cookie}; ${f.cookie}`]) {
    for (const [method, suffix, body] of [['POST', '', payload()], ['GET', '', undefined], ['GET', '/history', undefined]] as const) {
      assert.equal((await request(method, `/participant/events/${f.event.id}/rsvp${suffix}`, cookie, body)).status, 404);
    }
  }
  assert.equal((await request('POST', `/participant/events/${f.event.id}/rsvp`, f.cookie, { ...payload(), participantId: other.participant.id })).status, 400);
  assert.equal(await db.rsvp.count({ where: { participantId: f.participant.id } }), 0);
});

test('expired or revoked credentials cannot submit or read RSVP history', async () => {
  for (const kind of ['session', 'invitation', 'revoked']) {
    const f = await fixture(); await submit(f);
    if (kind === 'session') await db.participantSession.update({ where: { invitationId: f.invitation.id }, data: { expiresAt: new Date(0) } });
    else await db.invitationToken.update({ where: { id: f.invitation.id }, data: kind === 'revoked' ? { revokedAt: new Date() } : { createdAt: new Date(0), expiresAt: new Date(1000) } });
    assert.equal((await submit(f, payload('NO', 1))).status, 404); assert.equal((await history(f)).status, 404);
    assert.equal((await db.rsvp.findUniqueOrThrow({ where: { participantId: f.participant.id } })).response, 'YES');
  }
});

test('cancelled/draft/finalized events reject changes while organizer history is retained', async () => {
  for (const status of ['CANCELLED', 'DRAFT', 'FINALIZED'] as const) {
    const f = await fixture(); await submit(f); await db.event.update({ where: { id: f.event.id }, data: { status } });
    assert.equal((await submit(f, payload('NO', 1))).status, status === 'FINALIZED' ? 409 : 404);
    const rows = await request('GET', `/events/${f.event.id}/participants/${f.participant.id}/rsvp-history`, f.ownerCookie);
    assert.equal(rows.status, 200); assert.equal(rows.body.history.length, 1);
  }
});

test('cancellation racing with a response never permits later changes or corrupts history', async () => {
  const f = await fixture();
  const [r, cancel] = await Promise.all([submit(f), request('POST', `/events/${f.event.id}/cancel`, f.ownerCookie, {})]);
  assert.equal(cancel.status, 200); assert.ok([200, 404].includes(r.status));
  assert.equal((await submit(f)).status, 404);
  const count = await db.rsvpHistory.count({ where: { participantId: f.participant.id } }); assert.equal(count, r.status === 200 ? 1 : 0);
  assert.equal(await db.rsvp.count({ where: { participantId: f.participant.id } }), count);
});

test('organizer summaries count pending and each response, scope pagination and protect participant history', async () => {
  const f = await fixture(); const other = await fixture(); await submit(f);
  for (const response of ['NO', 'MAYBE', null] as const) {
    const participant = await db.participant.create({ data: { eventId: f.event.id, displayName: 'Guest', email: `${randomUUID()}@example.test` } });
    if (response) await db.rsvp.create({ data: { participantId: participant.id, response } });
  }
  const r = await request('GET', `/events/${f.event.id}/rsvps?limit=1`, f.ownerCookie);
  assert.equal(r.status, 200); assert.deepEqual(r.body.counts, { total: 4, YES: 1, NO: 1, MAYBE: 1, pending: 1 }); assert.equal(r.body.participants.length, 1);
  assert.ok(!JSON.stringify(r.body).includes('@example.test')); assert.equal(r.headers.get('cache-control'), 'no-store');
  for (const cookie of [undefined, f.cookie, other.ownerCookie]) assert.equal((await request('GET', `/events/${f.event.id}/rsvps`, cookie)).status, cookie === other.ownerCookie ? 404 : 401);
  assert.equal((await request('GET', `/events/${f.event.id}/participants/${other.participant.id}/rsvp-history`, f.ownerCookie)).status, 404);
  assert.equal((await request('GET', `/events/${f.event.id}/participants/${f.participant.id}/rsvp-history`, other.ownerCookie)).status, 404);
  for (const query of ['?limit=0', '?offset=-1', '?limit=101', '?participantId=forged']) assert.equal((await request('GET', `/events/${f.event.id}/rsvps${query}`, f.ownerCookie)).status, 400);
});

test('CSRF and strict submission validation reject unsafe writes; own history pagination is stable', async () => {
  const f = await fixture(); const bad: Record<string, string>[] = [{ Origin: '' }, { Origin: 'https://evil.example.test' }, { 'X-GroupOS-Request': '' }, { 'Content-Type': 'text/plain' }];
  for (const headers of bad) assert.equal((await request('POST', `/participant/events/${f.event.id}/rsvp`, f.cookie, payload(), headers)).status, 403);
  for (const body of [{}, { ...payload(), response: 'yes' }, { ...payload(), expectedVersion: -1 }, { ...payload(), expectedVersion: 1.5 }, { ...payload(), requestId: 'bad' }, { ...payload(), response: { set: 'YES' } }]) assert.equal((await request('POST', `/participant/events/${f.event.id}/rsvp`, f.cookie, body)).status, 400);
  await submit(f); await submit(f, payload('NO', 1));
  const page = await request('GET', `/participant/events/${f.event.id}/rsvp/history?limit=1&offset=1`, f.cookie);
  assert.equal(page.body.history.length, 1); assert.equal(page.body.history[0].revision, 2);
  assert.equal((await request('GET', `/participant/events/${f.event.id}/rsvp/history?limit=101`, f.cookie)).status, 400);
});
