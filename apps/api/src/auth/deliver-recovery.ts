import { config } from 'dotenv';
import { getDatabase, disconnectDatabase } from '../database.js';
import { readAuthSettings } from './security.js';
import { deliverRecoveryBatch, recoverySenderFromEnv, recoveryHealth } from './recovery-delivery.js';

config({ path: new URL('../../../../.env', import.meta.url) });
try {
  const db = getDatabase();
  const before = await recoveryHealth(db);
  if (process.argv.includes('--check')) {
    console.log({ recovery: before });
    if (before.expired || before.exhausted || before.stuck) process.exitCode = 1;
  } else {
    const result = await deliverRecoveryBatch(db, readAuthSettings(), recoverySenderFromEnv());
    const after = await recoveryHealth(db);
    console.log({ ...result, before, after });
    if (result.failed || before.expired || before.exhausted || before.stuck || after.stuck) process.exitCode = 1;
  }
} catch {
  console.error('Recovery delivery failed; verify configuration and database availability');
  process.exitCode = 1;
} finally {
  try { await disconnectDatabase(); }
  catch { console.error('Recovery database shutdown failed'); process.exitCode = 1; }
}
