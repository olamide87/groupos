import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { decryptRecovery, emailAddress, encryptRecovery, hashPassword, passwordInput, readAuthSettings, verifyPassword } from './security.js';
import { recoverySenderFromEnv } from './recovery-delivery.js';

test('scrypt hashes have unique salts and verify without accepting altered passwords or parameters', async () => {
  const password = 'A strong and long passphrase';
  const first = await hashPassword(password); const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(`${password}!`, first), false);
  assert.equal(await verifyPassword(password, first.replace('131072', '1')), false);
  assert.equal(await verifyPassword(password, null), false);
});

test('passwords are bounded without truncation and email input is normalized', () => {
  assert.equal(emailAddress(' Person@Example.test '), 'person@example.test');
  assert.throws(() => emailAddress('not-an-email'));
  assert.throws(() => emailAddress('x'.repeat(255)));
  assert.throws(() => passwordInput('short'));
  assert.throws(() => passwordInput('a'.repeat(129)));
  const passphrase = ' a sufficiently long passphrase ';
  assert.equal(passwordInput(passphrase), passphrase);
});

test('recovery payload encryption authenticates ciphertext and requires the correct key', () => {
  const key = randomBytes(32); const value = { email: 'person@example.test', resetUrl: 'https://example.test/#secret' };
  const message = encryptRecovery(value, key);
  assert.deepEqual(decryptRecovery(message, key), value);
  assert.throws(() => decryptRecovery(message, randomBytes(32)));
  assert.throws(() => decryptRecovery({ ...message, tag: '0'.repeat(32) }, key));
});

test('production auth fails closed without HTTPS, encryption key and an authenticated delivery endpoint', () => {
  const names = ['NODE_ENV', 'AUTH_ORIGIN', 'AUTH_RECOVERY_KEY', 'AUTH_RECOVERY_WEBHOOK_URL', 'AUTH_RECOVERY_WEBHOOK_SECRET'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.NODE_ENV = 'production'; process.env.AUTH_ORIGIN = 'http://example.test';
    process.env.AUTH_RECOVERY_KEY = randomBytes(32).toString('hex');
    assert.throws(readAuthSettings);
    process.env.AUTH_ORIGIN = 'https://example.test';
    assert.equal(readAuthSettings().secureCookies, true);
    delete process.env.AUTH_RECOVERY_KEY; assert.throws(readAuthSettings);
    delete process.env.AUTH_RECOVERY_WEBHOOK_URL; assert.throws(recoverySenderFromEnv);
    process.env.AUTH_RECOVERY_WEBHOOK_URL = 'http://example.test/mail';
    process.env.AUTH_RECOVERY_WEBHOOK_SECRET = 'x'.repeat(32); assert.throws(recoverySenderFromEnv);
    process.env.AUTH_RECOVERY_WEBHOOK_URL = 'https://example.test/mail';
    process.env.AUTH_RECOVERY_WEBHOOK_SECRET = 'short'; assert.throws(recoverySenderFromEnv);
    process.env.AUTH_RECOVERY_WEBHOOK_SECRET = 'x'.repeat(32);
    process.env.AUTH_RECOVERY_WEBHOOK_URL = 'https://user:password@example.test/mail'; assert.throws(recoverySenderFromEnv);
    process.env.AUTH_RECOVERY_WEBHOOK_URL = 'https://example.test/mail';
    assert.equal(typeof recoverySenderFromEnv(), 'function');
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
});

test('recovery webhook uses authentication, idempotency, timeout and redirect rejection without real network delivery', async () => {
  const names = ['AUTH_RECOVERY_WEBHOOK_URL', 'AUTH_RECOVERY_WEBHOOK_SECRET'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  try {
    process.env.AUTH_RECOVERY_WEBHOOK_URL = 'https://example.test/mail';
    process.env.AUTH_RECOVERY_WEBHOOK_SECRET = randomBytes(32).toString('hex');
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Authorization'), `Bearer ${process.env.AUTH_RECOVERY_WEBHOOK_SECRET}`);
      assert.equal(headers.get('Idempotency-Key'), 'test-message');
      assert.equal(init?.method, 'POST');
      return new Response('provider error containing private data', { status: 503 });
    };
    const send = recoverySenderFromEnv();
    assert.equal(calls, 0);
    await assert.rejects(send({ email: 'test@example.test', resetUrl: 'https://example.test/account#reset=synthetic', expiresAt: new Date().toISOString() }, 'test-message'),
      { message: 'Recovery delivery failed' });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
});
