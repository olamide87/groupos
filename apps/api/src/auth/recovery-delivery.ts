import type { PrismaClient } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decryptRecovery, type AuthSettings } from './security.js';

export interface RecoveryMail { email: string; resetUrl: string; expiresAt: string }
export type RecoverySender = (message: RecoveryMail, id: string) => Promise<void>;

// A bounded batch with leases supports retries and concurrent workers. Delivery must be idempotent by ID.
export async function deliverRecoveryBatch(db: PrismaClient, settings: AuthSettings, send: RecoverySender) {
  const now = new Date();
  await db.authSession.deleteMany({ where: { expiresAt: { lte: now } } });
  await db.passwordReset.deleteMany({ where: { OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }] } });
  const pending = await db.recoveryMessage.findMany({ where: { sentAt: null, attempts: { lt: 5 },
    OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] }, orderBy: { createdAt: 'asc' }, take: 20 });
  let sent = 0;
  let failed = 0;
  for (const message of pending) {
    const claimed = await db.recoveryMessage.updateMany({ where: { id: message.id, sentAt: null, attempts: { lt: 5 },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
      data: { attempts: { increment: 1 }, lockedUntil: new Date(Date.now() + 60_000) } });
    if (!claimed.count) continue;
    try {
      const decoded = decryptRecovery(message, settings.recoveryKey) as Partial<RecoveryMail>;
      if (!decoded || typeof decoded.email !== 'string' || typeof decoded.resetUrl !== 'string'
          || typeof decoded.expiresAt !== 'string' || !decoded.resetUrl.startsWith(`${settings.origin}/account#reset=`)) {
        throw new Error('Invalid recovery payload');
      }
      await send(decoded as RecoveryMail, message.id);
      await db.recoveryMessage.update({ where: { id: message.id }, data: { sentAt: new Date(), ciphertext: '', lockedUntil: null } });
      sent++;
    } catch {
      // Keep the lease as a retry delay; never persist/log provider errors or bearer tokens.
      failed++;
    }
  }
  return { sent, failed };
}

export function recoverySenderFromEnv(): RecoverySender {
  const endpoint = process.env.AUTH_RECOVERY_WEBHOOK_URL;
  if (endpoint) {
    const url = new URL(endpoint);
    const secret = process.env.AUTH_RECOVERY_WEBHOOK_SECRET ?? '';
    if (url.protocol !== 'https:' || url.username || url.password || secret.length < 32) {
      throw new Error('Recovery delivery requires an HTTPS webhook and a strong webhook secret');
    }
    return async (message, id) => {
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, 'Idempotency-Key': id },
        body: JSON.stringify(message) });
      if (!response.ok) throw new Error('Recovery delivery failed');
      await response.body?.cancel();
    };
  }
  if (process.env.NODE_ENV === 'production') throw new Error('A recovery delivery webhook is required in production');
  // Local development only: a private mailbox, never a public HTTP endpoint or console log.
  return async (message, id) => {
    const directory = new URL('../../../../.local/recovery-mailbox/', import.meta.url);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(fileURLToPath(new URL(`${id}.json`, directory)), JSON.stringify(message), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  };
}
