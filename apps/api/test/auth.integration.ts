import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app.js';
import { decryptRecovery, hashPassword, hashToken, type AuthSettings } from '../src/auth/security.js';
import { deliverRecoveryBatch, type RecoveryMail } from '../src/auth/recovery-delivery.js';
import { consumeRateLimit, defaultPolicies } from '../src/auth/rate-limit.js';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^groupos_test_[a-f0-9]{32}$/.test(process.env.GROUPOS_TEST_DATABASE ?? '')
    || url.pathname !== `/${process.env.GROUPOS_TEST_DATABASE}`) throw new Error('Run through the disposable database runner');
const db = new PrismaClient();
const password = 'A long test passphrase 42!';
const replacement = 'A different long passphrase 43!';
const settings: AuthSettings = { origin: 'http://app.example.test', secureCookies: false, recoveryKey: randomBytes(32) };
let storedHash: string;
before(async () => { await db.$connect(); storedHash = await hashPassword(password); });
after(() => db.$disconnect());
const email = () => `${randomUUID()}@example.test`;
const fixture = () => db.user.create({ data: { email: email(), name: 'Organizer', passwordHash: storedHash } });

async function client(config = settings, policies = Object.fromEntries(Object.entries(defaultPolicies).map(([key, value]) => [key, { ...value, ip: 1000, account: 1000 }]))) {
  const server = createApp({ database: () => db, settings: () => config, policies }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    async request(path: string, body?: object, cookie?: string, extraHeaders: Record<string, string> = {}) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: config.origin, 'Content-Type': 'application/json', 'X-GroupOS-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookie = response.headers.get('set-cookie');
      return { status: response.status, headers: response.headers, cookie: setCookie?.split(';')[0],
        body: response.status === 204 ? null : await response.json() as any };
    },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
async function resetToken(userId: string) {
  const message = await db.recoveryMessage.findFirstOrThrow({ where: { token: { userId, usedAt: null } }, orderBy: { createdAt: 'desc' } });
  const mail = decryptRecovery(message, settings.recoveryKey) as RecoveryMail;
  return { message, mail, token: new URLSearchParams(new URL(mail.resetUrl).hash.slice(1)).get('reset')! };
}

test('signup normalizes email, hashes passwords, rejects weak input and cannot overwrite an existing organizer', async () => {
  const c = await client();
  try {
    const address = email();
    assert.equal((await c.request('/api/v1/auth/signup', { email: address, name: 'New', password: 'short' })).status, 400);
    const first = await c.request('/api/v1/auth/signup', { email: ` ${address.toUpperCase()} `, name: ' New ', password, authVersion: 999 });
    assert.equal(first.status, 202);
    const row = await db.user.findUniqueOrThrow({ where: { email: address } });
    assert.equal(row.name, 'New'); assert.equal(row.authVersion, 0);
    assert.match(row.passwordHash!, /^scrypt\$131072\$8\$1\$/);
    assert.ok(!JSON.stringify(first.body).includes(row.passwordHash!));
    const duplicate = await c.request('/api/v1/auth/signup', { email: address, name: 'Intruder', password: replacement });
    assert.deepEqual(duplicate.body, first.body);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: row.id } })).passwordHash, row.passwordHash);
  } finally { await c.close(); }
});

test('login rejects unknown/wrong credentials uniformly, issues hashed sessions and rotates prior session', async () => {
  const c = await client(); const user = await fixture();
  try {
    const wrong = await c.request('/api/v1/auth/login', { email: user.email, password: replacement });
    const missing = await c.request('/api/v1/auth/login', { email: email(), password });
    assert.equal(wrong.status, 401); assert.deepEqual(wrong.body, missing.body);
    const login = await c.request('/api/v1/auth/login', { email: user.email, password });
    assert.equal(login.status, 200); assert.deepEqual(Object.keys(login.body.user).sort(), ['email', 'id', 'name']);
    assert.match(login.headers.get('set-cookie')!, /HttpOnly/); assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/);
    assert.match(login.headers.get('set-cookie')!, /Max-Age=3600/);
    const raw = login.cookie!.split('=')[1];
    assert.ok(await db.authSession.findUnique({ where: { tokenHash: hashToken(raw) } }));
    assert.equal(await db.authSession.findUnique({ where: { tokenHash: raw } }), null);
    const rotated = await c.request('/api/v1/auth/login', { email: user.email, password }, login.cookie);
    assert.notEqual(rotated.cookie, login.cookie);
    assert.equal((await c.request('/api/v1/auth/me', undefined, login.cookie)).status, 401);
    assert.equal((await c.request('/api/v1/auth/me', undefined, rotated.cookie)).status, 200);
  } finally { await c.close(); }
});

test('production cookies use __Host prefix, Secure, HttpOnly and host-only Path=/', async () => {
  const c = await client({ ...settings, origin: 'https://app.example.test', secureCookies: true }); const user = await fixture();
  try {
    const login = await c.request('/api/v1/auth/login', { email: user.email, password }, undefined, { 'X-Forwarded-Proto': 'http' });
    const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /^__Host-groupos_session=/); assert.match(cookie, /; Secure/);
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Path=\//); assert.doesNotMatch(cookie, /Domain=/i);
  } finally { await c.close(); }
});

test('unsafe methods require exact Origin, JSON and custom header; hostile CORS is not allowed', async () => {
  const c = await client();
  try {
    const rejectedHeaders: Record<string, string>[] = [{ Origin: 'https://evil.example.test' }, { Origin: '' }, { 'X-GroupOS-Request': '' }, { 'Content-Type': 'text/plain' }];
    for (const route of ['signup', 'login', 'logout', 'forgot', 'reset']) for (const headers of rejectedHeaders) {
      const response = await c.request(`/api/v1/auth/${route}`, {}, undefined, headers);
      assert.equal(response.status, 403);
    }
    const hostile = await c.request('/api/v1/auth/me', undefined, undefined, { Origin: 'https://evil.example.test' });
    assert.equal(hostile.headers.get('access-control-allow-origin'), null);
    assert.equal(hostile.headers.get('cache-control'), 'no-store');
  } finally { await c.close(); }
});

test('anonymous, forged, duplicate and expired sessions are denied; logout revokes immediately and is idempotent', async () => {
  const c = await client(); const user = await fixture();
  try {
    assert.equal((await c.request('/api/v1/auth/me')).status, 401);
    assert.equal((await c.request('/api/v1/auth/me', undefined, `groupos_session=${'f'.repeat(64)}`)).status, 401);
    const login = await c.request('/api/v1/auth/login', { email: user.email, password });
    assert.equal((await c.request('/api/v1/auth/me', undefined, `${login.cookie}; ${login.cookie}`)).status, 401);
    await db.authSession.update({ where: { tokenHash: hashToken(login.cookie!.split('=')[1]) }, data: { expiresAt: new Date(0) } });
    assert.equal((await c.request('/api/v1/auth/me', undefined, login.cookie)).status, 401);
    const active = await c.request('/api/v1/auth/login', { email: user.email, password });
    assert.equal((await c.request('/api/v1/auth/logout', {}, active.cookie)).status, 204);
    assert.equal((await c.request('/api/v1/auth/me', undefined, active.cookie)).status, 401);
    assert.equal((await c.request('/api/v1/auth/logout', {}, active.cookie)).status, 204);
  } finally { await c.close(); }
});

test('organizer event reads deny cross-account access and ignore caller-supplied identities', async () => {
  const c = await client(); const owner = await fixture(); const other = await fixture();
  const event = await db.event.create({ data: { organizerId: owner.id, title: 'Private outing' } });
  try {
    assert.equal((await c.request(`/api/v1/events/${event.id}`)).status, 401);
    const login = await c.request('/api/v1/auth/login', { email: other.email, password });
    const denied = await c.request(`/api/v1/events/${event.id}?organizerId=${owner.id}`, undefined, login.cookie);
    assert.equal(denied.status, 404); assert.ok(!JSON.stringify(denied.body).includes('Private outing'));
    const allowed = await c.request('/api/v1/auth/login', { email: owner.email, password });
    assert.equal((await c.request(`/api/v1/events/${event.id}`, undefined, allowed.cookie)).status, 200);
  } finally { await c.close(); }
});

test('recovery responses do not reveal account existence or tokens; encrypted outbox is delivered once', async () => {
  const c = await client(); const user = await fixture();
  try {
    const known = await c.request('/api/v1/auth/forgot', { email: user.email });
    const unknown = await c.request('/api/v1/auth/forgot', { email: email() });
    assert.equal(known.status, 202); assert.deepEqual(known.body, unknown.body);
    const { token, message } = await resetToken(user.id);
    assert.ok(!JSON.stringify(known.body).includes(token)); assert.ok(!message.ciphertext.includes(token));
    assert.ok(await db.passwordReset.findUnique({ where: { tokenHash: hashToken(token) } }));
    const deliveries: RecoveryMail[] = [];
    const send = async (mail: RecoveryMail) => { deliveries.push(mail); };
    const result = await deliverRecoveryBatch(db, settings, send);
    assert.equal(result.failed, 0); assert.equal(deliveries.filter(mail => mail.email === user.email).length, 1);
    assert.equal((await db.recoveryMessage.findUniqueOrThrow({ where: { id: message.id } })).ciphertext, '');
    const again = await deliverRecoveryBatch(db, settings, send);
    assert.equal(again.sent, 0);
  } finally { await c.close(); }
});

test('new recovery invalidates old links; expired and malformed reset tokens are rejected', async () => {
  const c = await client(); const user = await fixture();
  try {
    await c.request('/api/v1/auth/forgot', { email: user.email }); const old = await resetToken(user.id);
    await c.request('/api/v1/auth/forgot', { email: user.email }); const current = await resetToken(user.id);
    assert.equal((await c.request('/api/v1/auth/reset', { token: old.token, password: replacement })).status, 400);
    assert.equal((await c.request('/api/v1/auth/reset', { token: 'invalid', password: replacement })).status, 400);
    await db.passwordReset.update({ where: { tokenHash: hashToken(current.token) }, data: { expiresAt: new Date(0) } });
    assert.equal((await c.request('/api/v1/auth/reset', { token: current.token, password: replacement })).status, 400);
  } finally { await c.close(); }
});

test('concurrent resets consume a link once, revoke every session and require the new password', async () => {
  const c = await client(); const user = await fixture();
  try {
    const first = await c.request('/api/v1/auth/login', { email: user.email, password });
    const second = await c.request('/api/v1/auth/login', { email: user.email, password });
    await c.request('/api/v1/auth/forgot', { email: user.email }); const { token } = await resetToken(user.id);
    const results = await Promise.all([c.request('/api/v1/auth/reset', { token, password: replacement }), c.request('/api/v1/auth/reset', { token, password: replacement })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
    assert.equal((await c.request('/api/v1/auth/reset', { token, password })).status, 400);
    assert.equal((await c.request('/api/v1/auth/me', undefined, first.cookie)).status, 401);
    assert.equal((await c.request('/api/v1/auth/me', undefined, second.cookie)).status, 401);
    assert.equal((await c.request('/api/v1/auth/login', { email: user.email, password })).status, 401);
    assert.equal((await c.request('/api/v1/auth/login', { email: user.email, password: replacement })).status, 200);
    assert.equal(await db.auditEntry.count({ where: { actorUserId: user.id, action: 'auth.password-reset' } }), 1);
  } finally { await c.close(); }
});

test('delivery failures retain encrypted work for retry and never expose provider errors', async () => {
  const c = await client(); const user = await fixture();
  try {
    await c.request('/api/v1/auth/forgot', { email: user.email }); const { message } = await resetToken(user.id);
    const result = await deliverRecoveryBatch(db, settings, async () => { throw new Error('Provider secret must not escape'); });
    assert.ok(result.failed > 0);
    const pending = await db.recoveryMessage.findUniqueOrThrow({ where: { id: message.id } });
    assert.equal(pending.sentAt, null); assert.equal(pending.attempts, 1); assert.ok(pending.ciphertext);
    await db.recoveryMessage.update({ where: { id: message.id }, data: { lockedUntil: new Date(0) } });
    const retry = await deliverRecoveryBatch(db, settings, async () => {});
    assert.ok(retry.sent > 0);
  } finally { await c.close(); }
});

test('IP rate limits survive app recreation and cannot be bypassed with forwarded headers', async () => {
  const policies = { ...defaultPolicies, login: { ip: 2, account: 100, windowMs: 60_000 } };
  await db.authRateLimit.deleteMany();
  const c = await client(settings, policies);
  try {
    for (let i = 0; i < 2; i++) assert.equal((await c.request('/api/v1/auth/login', { email: email(), password }, undefined, { 'X-Forwarded-For': `192.0.2.${i}` })).status, 401);
  } finally { await c.close(); }
  const restarted = await client(settings, policies);
  try {
    const blocked = await restarted.request('/api/v1/auth/login', { email: email(), password }, undefined, { 'X-Forwarded-For': '192.0.2.99' });
    assert.equal(blocked.status, 429); assert.ok(blocked.headers.get('retry-after'));
  } finally { await restarted.close(); }
});

test('account rate limits resist changing peers; concurrent requests cannot exceed an atomic bucket', async () => {
  await db.authRateLimit.deleteMany();
  const policy = { ip: 100, account: 2, windowMs: 60_000 };
  const account = email(); const now = new Date();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => consumeRateLimit(db, 'concurrent', `peer-${i}`, account, policy, now)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  await consumeRateLimit(db, 'concurrent', 'peer-new', account, policy, new Date(now.getTime() + 120_000));
});

test('signup, recovery and reset routes apply limits before expensive or sensitive operations', async () => {
  await db.authRateLimit.deleteMany();
  const policies = Object.fromEntries(Object.entries(defaultPolicies).map(([key, value]) => [key, { ...value, ip: 1, account: 100 }]));
  const c = await client(settings, policies);
  try {
    for (const [route, body] of [
      ['signup', { email: email(), password: 'short', name: 'Test' }],
      ['forgot', { email: email() }],
      ['reset', { token: 'invalid', password: replacement }],
    ] as const) {
      const first = await c.request(`/api/v1/auth/${route}`, body);
      assert.notEqual(first.status, 429);
      assert.equal((await c.request(`/api/v1/auth/${route}`, body)).status, 429);
    }
  } finally { await c.close(); }
});

test('a login racing with password reset cannot leave an old-password session valid', async () => {
  await db.authRateLimit.deleteMany();
  const c = await client(); const user = await fixture();
  try {
    await c.request('/api/v1/auth/forgot', { email: user.email });
    const { token } = await resetToken(user.id);
    const [login, reset] = await Promise.all([
      c.request('/api/v1/auth/login', { email: user.email, password }),
      c.request('/api/v1/auth/reset', { token, password: replacement }),
    ]);
    assert.equal(reset.status, 200);
    assert.ok([200, 401].includes(login.status));
    if (login.cookie) assert.equal((await c.request('/api/v1/auth/me', undefined, login.cookie)).status, 401);
  } finally { await c.close(); }
});

test('concurrent delivery workers claim one message once', async () => {
  const c = await client(); const user = await fixture();
  try {
    await c.request('/api/v1/auth/forgot', { email: user.email });
    let delivered = 0;
    const send = async (mail: RecoveryMail) => { if (mail.email === user.email) delivered++; };
    await Promise.all([deliverRecoveryBatch(db, settings, send), deliverRecoveryBatch(db, settings, send)]);
    assert.equal(delivered, 1);
  } finally { await c.close(); }
});

test('a planted session cannot fixate login; version revocation denies an otherwise unexpired session', async () => {
  const c = await client(); const attacker = await fixture(); const victim = await fixture();
  try {
    const planted = await c.request('/api/v1/auth/login', { email: attacker.email, password });
    const login = await c.request('/api/v1/auth/login', { email: victim.email, password }, planted.cookie);
    assert.equal(login.status, 200); assert.notEqual(login.cookie, planted.cookie);
    assert.equal((await c.request('/api/v1/auth/me', undefined, planted.cookie)).status, 401);
    assert.equal((await c.request('/api/v1/auth/me', undefined, login.cookie)).body.user.id, victim.id);
    const tokenHash = hashToken(login.cookie!.split('=')[1]);
    const before = await db.authSession.findUniqueOrThrow({ where: { tokenHash } });
    await c.request('/api/v1/auth/me', undefined, login.cookie);
    assert.equal((await db.authSession.findUniqueOrThrow({ where: { tokenHash } })).expiresAt.getTime(), before.expiresAt.getTime());
    await db.user.update({ where: { id: victim.id }, data: { authVersion: { increment: 1 } } });
    assert.equal((await c.request('/api/v1/auth/me', undefined, login.cookie)).status, 401);
  } finally { await c.close(); }
});

test('email case, whitespace, route casing and proxy headers cannot bypass account limits', async () => {
  await db.authRateLimit.deleteMany();
  const c = await client(settings, { ...defaultPolicies, login: { ip: 100, account: 1, windowMs: 3_600_000 } });
  const user = await fixture();
  try {
    assert.equal((await c.request('/api/v1/auth/login', { email: user.email, password: replacement })).status, 401);
    const response = await c.request('/API/V1/AUTH/LOGIN/', { email: ` ${user.email.toUpperCase()} `, password }, undefined,
      { 'X-Forwarded-For': '192.0.2.45', 'X-Real-IP': '192.0.2.46', Forwarded: 'for=192.0.2.47;proto=https' });
    assert.equal(response.status, 429); assert.equal(response.headers.get('set-cookie'), null);
  } finally { await c.close(); }
});

test('delivery skips tokens expired or revoked after the batch was selected', async () => {
  const c = await client(); const users = await Promise.all([fixture(), fixture(), fixture()]);
  try {
    // Isolate delivery fixtures from pending messages left by other adversarial tests.
    await db.passwordReset.updateMany({ data: { usedAt: new Date() } });
    for (const user of users) await c.request('/api/v1/auth/forgot', { email: user.email });
    const delivered: string[] = [];
    await deliverRecoveryBatch(db, settings, async mail => {
      delivered.push(mail.email);
      if (mail.email === users[0].email) {
        await db.passwordReset.updateMany({ where: { userId: users[1].id }, data: { expiresAt: new Date(0) } });
        await db.passwordReset.updateMany({ where: { userId: users[2].id }, data: { usedAt: new Date() } });
      }
    });
    assert.deepEqual(delivered, [users[0].email]);
  } finally { await c.close(); }
});
