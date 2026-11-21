import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app.js';
import { hashPassword, hashToken } from '../src/auth/security.js';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^groupos_test_[a-f0-9]{32}$/.test(process.env.GROUPOS_TEST_DATABASE ?? '')
  || url.pathname !== `/${process.env.GROUPOS_TEST_DATABASE}`) throw new Error('Use disposable database runner');
const db = new PrismaClient();
const origin = 'http://events.example.test';
const server = createApp({ database: () => db, settings: () => ({ origin, secureCookies: false, recoveryKey: Buffer.alloc(32) }) });
let listening: ReturnType<typeof server.listen>; let base: string; let passwordHash: string;
before(async () => {
  passwordHash = await hashPassword('Synthetic organizer password');
  listening = server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => listening.once('listening', resolve));
  const address = listening.address(); assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}/api/v1/events`;
});
after(async () => { await new Promise<void>(resolve => listening.close(() => resolve())); await db.$disconnect(); });
async function organizer() {
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: 'Owner', passwordHash } });
  const token = randomBytes(32).toString('hex');
  await db.authSession.create({ data: { userId: user.id, tokenHash: hashToken(token), authVersion: 0, expiresAt: new Date(Date.now() + 3600000) } });
  return { user, cookie: `groupos_session=${token}`, token };
}
async function request(method: string, path = '', cookie?: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { Origin: origin, 'X-GroupOS-Request': '1',
    'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() as any };
}
async function create(cookie: string, data: object = {}) {
  const response = await request('POST', '', cookie, { title: 'Outing', ...data });
  assert.equal(response.status, 201); return response.body.event;
}

test('organizer creates, lists, reads and updates events with audit entries and no private identity fields', async () => {
  const { user, cookie } = await organizer();
  const event = await create(cookie, { title: ' Dinner ', startsAt: '2027-02-01T18:00:00Z', endsAt: '2027-02-01T20:00:00Z', timeZone: 'America/Chicago' });
  assert.equal(event.title, 'Dinner'); assert.equal(event.status, 'DRAFT'); assert.equal(event.organizerId, undefined);
  assert.equal((await request('GET', `/${event.id}`, cookie)).body.event.id, event.id);
  assert.deepEqual((await request('GET', '', cookie)).body.events.map((e: any) => e.id), [event.id]);
  const updated = await request('PATCH', `/${event.id}`, cookie, { title: 'Lunch', location: 'Park', status: 'OPEN' });
  assert.equal(updated.status, 200); assert.equal(updated.body.event.location, 'Park');
  assert.equal(updated.body.event.startsAt, event.startsAt);
  assert.equal(updated.headers.get('cache-control'), 'no-store');
  const stored = await db.event.findUniqueOrThrow({ where: { id: event.id } }); assert.equal(stored.organizerId, user.id);
  assert.deepEqual((await db.auditEntry.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } })).map(e => e.action), ['event.create', 'event.update']);
});

test('every operation requires a live session; revoked and expired sessions cannot mutate events', async () => {
  const o = await organizer(); const event = await create(o.cookie);
  for (const [method, path, body] of [['POST', '', { title: 'X' }], ['GET', '', undefined], ['GET', `/${event.id}`, undefined],
    ['PATCH', `/${event.id}`, { title: 'X' }], ['POST', `/${event.id}/cancel`, {}]] as const) {
    assert.equal((await request(method, path, undefined, body)).status, 401);
  }
  await db.authSession.update({ where: { tokenHash: hashToken(o.token) }, data: { expiresAt: new Date(0) } });
  assert.equal((await request('PATCH', `/${event.id}`, o.cookie, { title: 'X' })).status, 401);
  await db.authSession.delete({ where: { tokenHash: hashToken(o.token) } });
  assert.equal((await request('POST', `/${event.id}/cancel`, o.cookie, {})).status, 401);
});

test('cross-account reads, updates and cancellation are indistinguishable from missing events and have no side effects', async () => {
  const owner = await organizer(); const other = await organizer(); const event = await create(owner.cookie);
  for (const [method, suffix, body] of [['GET', '', undefined], ['PATCH', '', { title: 'Stolen' }], ['POST', '/cancel', {}]] as const) {
    const denied = await request(method, `/${event.id}${suffix}`, other.cookie, body);
    const absent = await request(method, `/${randomUUID()}${suffix}`, other.cookie, body);
    assert.equal(denied.status, 404); assert.deepEqual(denied.body, absent.body);
  }
  assert.deepEqual((await request('GET', '', other.cookie)).body.events, []);
  assert.equal((await request('GET', '/not-a-uuid', owner.cookie)).status, 404);
  assert.equal((await db.event.findUniqueOrThrow({ where: { id: event.id } })).title, 'Outing');
  assert.equal(await db.auditEntry.count({ where: { eventId: event.id } }), 1);
});

test('mass assignment, nested writes and invalid fields are rejected without creating or changing data', async () => {
  const o = await organizer();
  for (const data of [{ organizerId: randomUUID() }, { organizer: { connect: { id: o.user.id } } }, { id: randomUUID() },
    { title: '' }, { title: 'a'.repeat(201) }, { description: 'a'.repeat(4001) }, { location: 1 }, { timeZone: 'Mars/Here' },
    { startsAt: '2027-02-30T10:00:00Z' }, { startsAt: 'tomorrow' }, { endsAt: '2027-01-01T10:00:00Z' },
    { startsAt: '2027-01-02T10:00:00Z', endsAt: '2027-01-01T10:00:00Z' }, { status: 'CANCELLED' }, { status: 'FINALIZED' }]) {
    assert.equal((await request('POST', '', o.cookie, { title: 'Test', ...data })).status, 400);
  }
  assert.equal(await db.event.count({ where: { organizerId: o.user.id } }), 0);
  const e = await create(o.cookie, { startsAt: '2027-01-01T10:00:00Z', endsAt: '2027-01-02T10:00:00Z' });
  for (const data of [{}, { startsAt: null }, { startsAt: '2027-01-03T10:00:00Z' }, { organizerId: randomUUID() }]) {
    assert.equal((await request('PATCH', `/${e.id}`, o.cookie, data)).status, 400);
  }
  assert.equal((await request('PATCH', `/${e.id}`, o.cookie, { startsAt: null, endsAt: null, location: null })).status, 200);
});

test('all event mutations enforce Origin, JSON and custom-header CSRF protections', async () => {
  const o = await organizer(); const e = await create(o.cookie);
  const rejected: Record<string, string>[] = [{ Origin: 'https://evil.example.test' }, { Origin: '' }, { 'X-GroupOS-Request': '' }, { 'Content-Type': 'text/plain' }];
  for (const headers of rejected) {
    for (const [method, path, body] of [['POST', '', { title: 'X' }], ['PATCH', `/${e.id}`, { title: 'X' }], ['POST', `/${e.id}/cancel`, {}]] as const) {
      assert.equal((await request(method, path, o.cookie, body, headers)).status, 403);
    }
  }
  assert.equal((await db.event.findUniqueOrThrow({ where: { id: e.id } })).status, 'DRAFT');
});

test('cancellation is idempotent, revokes invitations, retains related data and prevents reopening', async () => {
  const o = await organizer(); const e = await create(o.cookie);
  const participant = await db.participant.create({ data: { eventId: e.id, displayName: 'Guest' } });
  const invitation = await db.invitationToken.create({ data: { eventId: e.id, participantId: participant.id, tokenHash: hashToken(randomUUID()), expiresAt: new Date(Date.now() + 3600000) } });
  for (let i = 0; i < 2; i++) assert.equal((await request('POST', `/${e.id}/cancel`, o.cookie, {})).body.event.status, 'CANCELLED');
  assert.equal(await db.participant.count({ where: { eventId: e.id } }), 1);
  assert.ok((await db.invitationToken.findUniqueOrThrow({ where: { id: invitation.id } })).revokedAt);
  assert.equal(await db.auditEntry.count({ where: { eventId: e.id, action: 'event.cancel' } }), 1);
  assert.equal((await request('PATCH', `/${e.id}`, o.cookie, { status: 'OPEN' })).status, 409);
  assert.equal((await request('GET', `/${e.id}`, o.cookie)).status, 200);
});

test('pagination and status filtering remain owner scoped and reject unbounded or forged filters', async () => {
  const o = await organizer(); const other = await organizer(); await create(other.cookie);
  const first = await create(o.cookie); const second = await create(o.cookie, { status: 'OPEN' });
  const a = await request('GET', '?limit=1&offset=0', o.cookie); const b = await request('GET', '?limit=1&offset=1', o.cookie);
  assert.notEqual(a.body.events[0].id, b.body.events[0].id);
  assert.deepEqual(new Set([a.body.events[0].id, b.body.events[0].id]), new Set([first.id, second.id]));
  assert.deepEqual((await request('GET', '?status=OPEN', o.cookie)).body.events.map((e: any) => e.id), [second.id]);
  for (const query of ['?limit=0', '?limit=101', '?offset=-1', '?offset=10001', '?status=BOGUS', '?limit=1&limit=2', `?organizerId=${other.user.id}`]) {
    assert.equal((await request('GET', query, o.cookie)).status, 400);
  }
});

test('concurrent edits cannot reopen cancellation and finalized events are read-only except cancellation', async () => {
  const o = await organizer(); const e = await create(o.cookie);
  const [patch, cancel] = await Promise.all([request('PATCH', `/${e.id}`, o.cookie, { status: 'OPEN' }), request('POST', `/${e.id}/cancel`, o.cookie, {})]);
  assert.ok([200, 409].includes(patch.status)); assert.equal(cancel.status, 200);
  assert.equal((await db.event.findUniqueOrThrow({ where: { id: e.id } })).status, 'CANCELLED');
  const finalized = await create(o.cookie); await db.event.update({ where: { id: finalized.id }, data: { status: 'FINALIZED' } });
  assert.equal((await request('PATCH', `/${finalized.id}`, o.cookie, { title: 'X' })).status, 409);
  assert.equal((await request('POST', `/${finalized.id}/cancel`, o.cookie, {})).status, 200);
});
