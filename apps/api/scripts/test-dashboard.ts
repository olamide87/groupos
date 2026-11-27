import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app.js';

const require = createRequire(import.meta.url);
const raw = process.env.TEST_DATABASE_URL ?? '';
const control = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(control.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(control.hostname) || control.pathname !== '/groupos_test' || control.search || control.hash) throw new Error('Dashboard tests require a loopback /groupos_test control database');
const name = `groupos_test_${randomUUID().replaceAll('-', '')}`;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const admin = new pg.Client({ connectionString: raw });
let created = false; let db: PrismaClient | undefined; let api: ReturnType<ReturnType<typeof createApp>['listen']> | undefined; let web: ChildProcess | undefined;
try {
  await admin.connect(); await admin.query(`CREATE DATABASE "${name}"`); created = true;
  const url = new URL(control); url.pathname = `/${name}`;
  const env = { ...process.env, DATABASE_URL: url.toString(), GROUPOS_TEST_DATABASE: name };
  const migrated = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: 'inherit', windowsHide: true });
  if (migrated.status !== 0) throw new Error('Dashboard test migration failed');
  db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  // Synthetic local settings only. No recovery delivery worker or external service runs.
  api = createApp({ database: () => db!, settings: () => ({ origin: 'http://localhost:3000', secureCookies: false, recoveryKey: randomBytes(32) }) }).listen(4100, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { api!.once('listening', resolve); api!.once('error', reject); });
  web = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', '3000'], { cwd: fileURLToPath(new URL('../../web/', import.meta.url)), env: { ...env, NODE_ENV: 'production' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Test frontend readiness timeout')), 30000); web!.stdout!.on('data', data => { if (String(data).includes('Ready')) { clearTimeout(timer); resolve(); } }); web!.once('exit', () => { clearTimeout(timer); reject(new Error('Test frontend failed to start; check that port 3000 is unused')); }); });
  const result = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', 'apps/web/playwright.config.ts'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
  if (result !== 0) throw new Error(`Dashboard browser tests exited ${result}`);
} finally {
  if (web?.pid && web.exitCode === null && web.signalCode === null) {
    // Register before signaling: a fast exit must not race the waiter.
    const stopped = new Promise<void>(resolve => web!.once('exit', () => resolve()));
    web.kill(); await stopped;
  }
  if (api) await new Promise<void>(resolve => api!.close(() => resolve()));
  await db?.$disconnect();
  try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); } finally { await admin.end(); }
  console.log('Dashboard disposable database and owned servers cleaned up');
}
