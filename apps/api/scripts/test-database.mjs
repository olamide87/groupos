import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from 'dotenv';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  // Verify upgrading a populated GOS-002 database, not only deploying into an empty one.
  const baseline = await mkdtemp(join(tmpdir(), 'groupos-migration-baseline-'));
  try {
    await cp(join(cwd, 'prisma/schema.prisma'), join(baseline, 'schema.prisma'));
    await mkdir(join(baseline, 'migrations'));
    await cp(join(cwd, 'prisma/migrations/migration_lock.toml'), join(baseline, 'migrations/migration_lock.toml'));
    await cp(join(cwd, 'prisma/migrations/20261114000000_initial'), join(baseline, 'migrations/20261114000000_initial'), { recursive: true });
    run([prisma, 'migrate', 'deploy', '--schema', join(baseline, 'schema.prisma')]);
    const legacy = new pg.Client({ connectionString: url.toString() });
    await legacy.connect();
    try {
      const owner = randomUUID();
      await legacy.query('INSERT INTO "User" (id,email,name,"updatedAt") VALUES ($1,$2,$3,NOW())', [owner, `legacy-${name}@example.test`, 'Legacy organizer']);
      const eventId = randomUUID(); const participantId = randomUUID();
      await legacy.query('INSERT INTO "Event" (id,"organizerId",title,"updatedAt") VALUES ($1,$2,$3,NOW())', [eventId, owner, 'Pre-auth event']);
      await legacy.query('INSERT INTO "Participant" (id,"eventId","displayName","updatedAt") VALUES ($1,$2,$3,NOW())', [participantId, eventId, 'Legacy participant']);
      await legacy.query('INSERT INTO "Rsvp" ("participantId",response,"updatedAt") VALUES ($1,\'MAYBE\',NOW())', [participantId]);
      await legacy.query('INSERT INTO "RsvpHistory" (id,"participantId",response) VALUES ($1,$2,\'MAYBE\')', [randomUUID(), participantId]);
      await legacy.query('INSERT INTO "InvitationToken" (id,"eventId","participantId","tokenHash","expiresAt") VALUES ($1,$2,$3,$4,NOW()+INTERVAL \'1 day\')',
        [randomUUID(), eventId, participantId, randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')]);
    } finally { await legacy.end(); }
  } finally { await rm(baseline, { recursive: true, force: true }); }
  run([prisma, 'migrate', 'deploy']);
  // A second deploy must be a no-op, not a reset or a duplicate migration.
  run([prisma, 'migrate', 'deploy']);
  run([prisma, 'migrate', 'diff', '--from-url', url.toString(), '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code']);
  run(['--import', 'tsx', '--test', '--test-concurrency=1', 'test/database.integration.ts', 'test/auth.integration.ts', 'test/events.integration.ts', 'test/invitations.integration.ts', 'test/rsvps.integration.ts']);
} finally {
  try {
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
