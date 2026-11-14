import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from 'dotenv';

config({ path: new URL('../../../.env', import.meta.url) });
const require = createRequire(import.meta.url);
const raw = process.env.TEST_DATABASE_URL;
if (!raw) throw new Error('TEST_DATABASE_URL must point to a dedicated local test server');
const url = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/groupos_test' || url.search || url.hash) {
  throw new Error('Tests require a loopback PostgreSQL URL ending in /groupos_test without query parameters');
}
const name = `groupos_test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: raw });
let created = false;
const cwd = fileURLToPath(new URL('../', import.meta.url));
try {
  await admin.connect();
  // Only the unique database created by this invocation is ever migrated/dropped.
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  url.pathname = `/${name}`;
  const env = { ...process.env, DATABASE_URL: url.toString(), GROUPOS_TEST_DATABASE: name };
  const run = (args) => {
    const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Database verification exited ${result.status}`);
  };
  const prisma = require.resolve('prisma/build/index.js');
  run([prisma, 'migrate', 'deploy']);
  // A second deploy must be a no-op, not a reset or a duplicate migration.
  run([prisma, 'migrate', 'deploy']);
  run([prisma, 'migrate', 'diff', '--from-url', url.toString(), '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code']);
  run(['--import', 'tsx', '--test', 'test/database.integration.ts']);
} finally {
  try {
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
