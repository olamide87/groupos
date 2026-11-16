import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { createApp } from '../src/app.js';
import { hashToken, type AuthSettings } from '../src/auth/security.js';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^groupos_test_[a-f0-9]{32}$/.test(process.env.GROUPOS_TEST_DATABASE ?? '') || url.pathname !== `/${process.env.GROUPOS_TEST_DATABASE}`) throw new Error('Use disposable database runner');
const db = new PrismaClient();
const config: AuthSettings = { origin: 'https://invite.example.test', secureCookies: true, recoveryKey: randomBytes(32) };
const policies = { invitationIssue: { ip: 1000, account: 1000, windowMs: 3600000 }, invitationAccept: { ip: 1000, account: 1000, windowMs: 900000 } };
const app = createApp({ database: () => db, settings: () => config, policies });
let server: ReturnType<typeof app.listen>; let base: string;
before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}/api/v1`;
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.$disconnect(); });
async function request(method: string, path: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method, headers: { Origin: config.origin, 'Content-Type': 'application/json', 'X-GroupOS-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: r.status === 204 ? null : await r.json() as any, headers: r.headers, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
async function fixture() {
  const owner = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: 'Organizer', passwordHash: 'test-fixture-no-login' } });
  const token = randomBytes(32).toString('hex');
  await db.authSession.create({ data: { tokenHash: hashToken(token), userId: owner.id, authVersion: 0, expiresAt: new Date(Date.now() + 3600000) } });
  const event = await db.event.create({ data: { organizerId: owner.id, title: 'Private outing', status: 'OPEN' } });
  return { owner, event, cookie: `__Host-groupos_session=${token}` };
}
async function issue(f: Awaited<ReturnType<typeof fixture>>, body: object = { displayName: 'Guest' }) {
  const r = await request('POST', `/events/${f.event.id}/invitations`, f.cookie, body); assert.equal(r.status, 201);
  const link = new URL(r.body.invitationUrl); const fragment = new URLSearchParams(link.hash.slice(1));
  return { ...r.body.invitation, token: fragment.get('token') as string, link, response: r };
}
const accept = (eventId: string, token: string, headers?: Record<string, string>) => request('POST', `/participant/events/${eventId}/accept`, undefined, { token }, headers);
const view = (eventId: string, cookie?: string) => request('GET', `/participant/events/${eventId}`, cookie);

test('issuance returns a fragment link once and persists only token hashes; metadata omits secrets', async () => {
  const f = await fixture(); const i = await issue(f); const other = await issue(f);
  assert.match(i.token, /^[a-f0-9]{64}$/); assert.notEqual(i.token, other.token);
  assert.equal(i.link.origin, config.origin); assert.equal(i.link.pathname, '/invite'); assert.equal(i.link.search, '');
  const stored = await db.invitationToken.findUniqueOrThrow({ where: { id: i.id } });
  assert.equal(stored.tokenHash, hashToken(i.token)); assert.ok(!JSON.stringify(stored).includes(i.token));
  const list = await request('GET', `/events/${f.event.id}/invitations`, f.cookie);
  assert.equal(list.status, 200); assert.ok(!JSON.stringify(list.body).includes(i.token)); assert.ok(!JSON.stringify(list.body).includes(stored.tokenHash));
  assert.equal(i.response.headers.get('cache-control'), 'no-store'); assert.equal(i.response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await db.notificationConsent.count({ where: { participantId: i.participantId } }), 0);
});

test('acceptance creates one hash-only secure session and returns only the event and own participant', async () => {
  const f = await fixture(); const i = await issue(f); await issue(f, { displayName: 'Other private guest' });
  const accepted = await accept(f.event.id, i.token); assert.equal(accepted.status, 200);
  const cookie = accepted.headers.get('set-cookie')!;
  assert.match(cookie, /^__Host-groupos_participant=/); assert.match(cookie, /Secure/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\//); assert.doesNotMatch(cookie, /Domain=/i);
  const rawSession = accepted.cookie!.split('=')[1];
  const session = await db.participantSession.findUniqueOrThrow({ where: { invitationId: i.id } });
  assert.equal(session.tokenHash, hashToken(rawSession)); assert.notEqual(session.tokenHash, rawSession);
  assert.ok(session.expiresAt <= new Date(i.expiresAt));
  const result = await view(f.event.id, accepted.cookie); assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['event', 'participant']);
  assert.deepEqual(result.body.participant, { id: i.participantId, displayName: 'Guest' });
  assert.ok(!JSON.stringify(result.body).includes('Other private guest')); assert.ok(!JSON.stringify(result.body).includes(f.owner.email));
  assert.equal((await request('GET', `/events/${f.event.id}`, accepted.cookie)).status, 401);
  assert.equal(await db.rsvp.count({ where: { participantId: i.participantId } }), 0);
});

test('expiration applies to invitation acceptance, active invitation and participant session', async () => {
  const f = await fixture(); const i = await issue(f);
  await db.invitationToken.update({ where: { id: i.id }, data: { createdAt: new Date(0), expiresAt: new Date(1000) } });
  assert.equal((await accept(f.event.id, i.token)).status, 404);
  const j = await issue(f); const a = await accept(f.event.id, j.token);
  await db.participantSession.update({ where: { invitationId: j.id }, data: { expiresAt: new Date(0) } });
  assert.equal((await view(f.event.id, a.cookie)).status, 404);
  const k = await issue(f); const b = await accept(f.event.id, k.token);
  await db.invitationToken.update({ where: { id: k.id }, data: { createdAt: new Date(0), expiresAt: new Date(1000) } });
  assert.equal((await view(f.event.id, b.cookie)).status, 404);
});

test('revocation is idempotent and denies both unused links and established sessions', async () => {
  const f = await fixture(); const i = await issue(f); const j = await issue(f); const accepted = await accept(f.event.id, j.token);
  for (const invitation of [i, j]) for (let n = 0; n < 2; n++) assert.equal((await request('POST', `/events/${f.event.id}/invitations/${invitation.id}/revoke`, f.cookie, {})).status, 204);
  assert.equal((await accept(f.event.id, i.token)).status, 404); assert.equal((await view(f.event.id, accepted.cookie)).status, 404);
  assert.equal(await db.auditEntry.count({ where: { entityId: j.id, action: 'invitation.revoke' } }), 1);
});

test('replay and simultaneous acceptance produce exactly one session and one acceptance audit record', async () => {
  const f = await fixture(); const i = await issue(f);
  const results = await Promise.all(Array.from({ length: 6 }, () => accept(f.event.id, i.token)));
  assert.equal(results.filter(r => r.status === 200).length, 1); assert.equal(results.filter(r => r.status === 404).length, 5);
  assert.equal((await accept(f.event.id, i.token)).status, 404);
  assert.equal(await db.participantSession.count({ where: { invitationId: i.id } }), 1);
  assert.equal(await db.auditEntry.count({ where: { entityId: i.id, action: 'invitation.accept' } }), 1);
});

test('organizer authorization denies issuance, metadata and revocation across accounts and events', async () => {
  const f = await fixture(); const other = await fixture(); const i = await issue(f);
  for (const cookie of [undefined, other.cookie]) {
    for (const [method, path, body] of [['POST', `/events/${f.event.id}/invitations`, { displayName: 'X' }], ['GET', `/events/${f.event.id}/invitations`, undefined], ['POST', `/events/${f.event.id}/invitations/${i.id}/revoke`, {}]] as const) {
      assert.equal((await request(method, path, cookie, body)).status, cookie ? 404 : 401);
    }
  }
  assert.equal((await request('POST', `/events/${other.event.id}/invitations/${i.id}/revoke`, other.cookie, {})).status, 404);
  assert.equal((await request('POST', `/events/${other.event.id}/invitations`, other.cookie, { participantId: i.participantId })).status, 404);
  await assert.rejects(db.invitationToken.create({ data: { eventId: other.event.id, participantId: i.participantId, tokenHash: hashToken(randomUUID()), expiresAt: new Date(Date.now() + 3600000) } }),
    (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003');
});

test('participant links and sessions cannot cross events, accept forged identities or bypass cookie validation', async () => {
  const f = await fixture(); const other = await fixture(); const i = await issue(f);
  assert.equal((await accept(other.event.id, i.token)).status, 404);
  assert.equal((await request('POST', `/participant/events/${f.event.id}/accept`, undefined, { token: i.token, participantId: randomUUID() })).status, 404);
  const a = await accept(f.event.id, i.token); assert.equal(a.status, 200);
  for (const cookie of [undefined, `${a.cookie}; ${a.cookie}`, `__Host-groupos_participant=${'f'.repeat(64)}`, f.cookie]) assert.equal((await view(f.event.id, cookie)).status, 404);
  assert.equal((await view(other.event.id, a.cookie)).status, 404);
  const good = await view(f.event.id, a.cookie); assert.equal(good.body.participant.id, i.participantId);
});

test('cancelled and draft events cannot issue or accept invitations; cancellation denies existing sessions', async () => {
  const f = await fixture(); const i = await issue(f); const j = await issue(f); const a = await accept(f.event.id, j.token);
  assert.equal((await request('POST', `/events/${f.event.id}/cancel`, f.cookie, {})).status, 200);
  assert.equal((await accept(f.event.id, i.token)).status, 404); assert.equal((await view(f.event.id, a.cookie)).status, 404);
  assert.equal((await request('POST', `/events/${f.event.id}/invitations`, f.cookie, { displayName: 'X' })).status, 409);
  // Even legacy unrevoked rows cannot bypass the event status check.
  await db.invitationToken.update({ where: { id: i.id }, data: { revokedAt: null } });
  assert.equal((await accept(f.event.id, i.token)).status, 404);
  await db.event.update({ where: { id: f.event.id }, data: { status: 'DRAFT' } });
  assert.equal((await accept(f.event.id, i.token)).status, 404);
});

test('reissue invalidates old links and sessions; concurrent issuance leaves only one active invitation', async () => {
  const f = await fixture(); const i = await issue(f); const a = await accept(f.event.id, i.token);
  const results = await Promise.all([issue(f, { participantId: i.participantId }), issue(f, { participantId: i.participantId })]);
  assert.equal((await view(f.event.id, a.cookie)).status, 404);
  const accepted = await Promise.all(results.map(j => accept(f.event.id, j.token)));
  assert.deepEqual(accepted.map(r => r.status).sort(), [200, 404]);
  assert.equal(await db.invitationToken.count({ where: { eventId: f.event.id, participantId: i.participantId, revokedAt: null } }), 1);
});

test('acceptance racing with cancellation or revocation never leaves authorized participant access', async () => {
  for (const cancel of [true, false]) {
    const f = await fixture(); const i = await issue(f);
    const [a, changed] = await Promise.all([accept(f.event.id, i.token), request('POST', cancel ? `/events/${f.event.id}/cancel` : `/events/${f.event.id}/invitations/${i.id}/revoke`, f.cookie, {})]);
    assert.ok([200, 404].includes(a.status)); assert.equal(changed.status, cancel ? 200 : 204);
    if (a.cookie) assert.equal((await view(f.event.id, a.cookie)).status, 404);
    assert.equal((await accept(f.event.id, i.token)).status, 404);
  }
});

test('validation and CSRF reject unsafe invitation operations without disclosing tokens', async () => {
  const f = await fixture(); const i = await issue(f);
  for (const body of [{ displayName: '' }, { displayName: 'a'.repeat(121) }, { displayName: 'X', expiresInHours: 0 }, { displayName: 'X', expiresInHours: 169 }, { displayName: 'X', expiresInHours: 1.5 }, { displayName: 'X', eventId: randomUUID() }]) {
    assert.equal((await request('POST', `/events/${f.event.id}/invitations`, f.cookie, body)).status, 400);
  }
  const rejected: Record<string, string>[] = [{ Origin: 'https://evil.example.test' }, { Origin: '' }, { 'Content-Type': 'text/plain' }, { 'X-GroupOS-Request': '' }];
  for (const headers of rejected) {
    assert.equal((await accept(f.event.id, i.token, headers)).status, 403);
    assert.equal((await request('POST', `/events/${f.event.id}/invitations/${i.id}/revoke`, f.cookie, {}, headers)).status, 403);
    assert.equal((await request('POST', `/events/${f.event.id}/invitations`, f.cookie, { displayName: 'X' }, headers)).status, 403);
  }
  const malformed = await accept(f.event.id, 'bad'); const forged = await accept(f.event.id, 'f'.repeat(64));
  assert.deepEqual(malformed.body, forged.body); assert.equal(malformed.status, 404);
});

test('persistent acceptance rate limits reject forwarded-header bypass across app instances', async () => {
  await db.authRateLimit.deleteMany();
  const make = async () => {
    const s = createApp({ database: () => db, settings: () => config, policies: { invitationAccept: { ip: 1, account: 100, windowMs: 3600000 } } }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => s.once('listening', resolve)); const address = s.address(); assert.ok(address && typeof address !== 'string');
    return { s, url: `http://127.0.0.1:${address.port}/api/v1/participant/events/${randomUUID()}/accept` };
  };
  for (let n = 0; n < 2; n++) {
    const { s, url } = await make();
    try {
      const r = await fetch(url, { method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json', 'X-GroupOS-Request': '1', 'X-Forwarded-For': `192.0.2.${n}` }, body: JSON.stringify({ token: randomBytes(32).toString('hex') }) });
      assert.equal(r.status, n ? 429 : 404); if (n) assert.ok(r.headers.get('retry-after')); await r.text();
    } finally { await new Promise<void>(resolve => s.close(() => resolve())); }
  }
});
