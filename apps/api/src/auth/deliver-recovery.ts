import { config } from 'dotenv';
import { getDatabase, disconnectDatabase } from '../database.js';
import { readAuthSettings } from './security.js';
import { deliverRecoveryBatch, recoverySenderFromEnv } from './recovery-delivery.js';

config({ path: new URL('../../../../.env', import.meta.url) });
try {
  const settings = readAuthSettings();
  const send = recoverySenderFromEnv();
  console.log(await deliverRecoveryBatch(getDatabase(), settings, send));
} catch {
  console.error('Recovery delivery failed; verify configuration and database availability');
  process.exitCode = 1;
} finally { await disconnectDatabase(); }
