import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { disconnectDatabase, getDatabase } from './database.js';

test('database initialization requires explicit configuration', async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.throws(getDatabase, /DATABASE_URL is required/);
    await disconnectDatabase();
  } finally {
    if (previous !== undefined) process.env.DATABASE_URL = previous;
  }
});

for (const [label, url] of [
  ['remote server', 'postgresql://test@example.invalid/groupos_test'],
  ['development database', 'postgresql://test@127.0.0.1/groupos'],
  ['connection overrides', 'postgresql://test@127.0.0.1/groupos_test?host=example.invalid'],
  ['wrong protocol', 'https://127.0.0.1/groupos_test'],
]) {
  test(`database test runner refuses ${label} before connecting`, () => {
    const result = spawnSync(process.execPath,
      [fileURLToPath(new URL('../scripts/test-database.mjs', import.meta.url))],
      { env: { ...process.env, TEST_DATABASE_URL: url }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Tests require a loopback PostgreSQL URL/);
  });
}
