import type { PrismaClient } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decryptRecovery, hashToken, validToken, type AuthSettings } from './security.js';

export interface RecoveryMail { email: string; resetUrl: string; expiresAt: string }
export type RecoverySender = (message: RecoveryMail, id: string) => Promise<void>;

// A bounded batch with leases supports retries and concurrent workers. Delivery must be idempotent by ID.
export async function deliverRecoveryBatch(db: PrismaClient, settings: AuthSettings, send: RecoverySender) {
  const now = new Date();
  await db.participantSession.deleteMany({ where: { expiresAt: { lte: now } } });
  await db.authSession.deleteMany({ where: { expiresAt: { lte: now } } });
  await db.passwordReset.deleteMany({ where: { OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }] } });
  const pending = await db.recoveryMessage.findMany({ where: { sentAt: null, attempts: { lt: 5 },
    OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] }, orderBy: { createdAt: 'asc' }, take: 20 });
  let sent = 0;
  let failed = 0;
  for (const message of pending) {
    if (Date.now() - now.getTime() >= 40_000) break;
    // A prior delivery can take time; recheck validity when claiming each message.
    const claimTime = new Date();
    const leaseUntil = new Date(claimTime.getTime() + 60_000);
    const claimed = await db.recoveryMessage.updateMany({ where: { id: message.id, sentAt: null, attempts: { equals: message.attempts, lt: 5 },
      token: { usedAt: null, expiresAt: { gt: claimTime } },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: claimTime } }] },
      data: { attempts: { increment: 1 }, lockedUntil: leaseUntil } });
    if (!claimed.count) continue;
    try {
      const decoded = decryptRecovery(message, settings.recoveryKey) as Partial<RecoveryMail>;
      if (!decoded || typeof decoded.email !== 'string' || typeof decoded.resetUrl !== 'string'
          || typeof decoded.expiresAt !== 'string' || !Number.isFinite(Date.parse(decoded.expiresAt))
          || Date.parse(decoded.expiresAt) <= Date.now() || !decoded.resetUrl.startsWith(`${settings.origin}/account#reset=`)) {
        throw new Error('Invalid recovery payload');
      }
      const raw = decoded.resetUrl.slice(`${settings.origin}/account#reset=`.length);
      if (!validToken(raw) || hashToken(raw) !== message.tokenHash) throw new Error('Invalid recovery payload');
      await send(decoded as RecoveryMail, message.id);
      // sentAt records sender acceptance, not inbox delivery or reset-token validity.
      // Invalidating the token during send cannot undo acceptance; acknowledge it and
      // erase the payload without retrying. Reset authorization rechecks validity.
      // Fence acknowledgements: a stale worker must not clear a newer worker's lease/payload.
      const acknowledged = await db.recoveryMessage.updateMany({ where: { id: message.id, sentAt: null,
        attempts: message.attempts + 1, lockedUntil: leaseUntil },
        data: { sentAt: new Date(), ciphertext: '', lockedUntil: null } });
      if (acknowledged.count) sent++;
      else failed++;
    } catch {
      // Keep the lease as a retry delay; never persist/log provider errors or bearer tokens.
      failed++;
    }
  }
  return { sent, failed };
}

// Operator-only aggregate snapshot; never expose addresses, tokens, payloads or IDs.
export async function recoveryHealth(db: PrismaClient, now = new Date()) {
  const unsent = { sentAt: null };
  const [pending, expired, exhausted, stuck, oldest] = await Promise.all([
    db.recoveryMessage.count({ where: unsent }),
    db.recoveryMessage.count({ where: { ...unsent, token: { OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }] } } }),
    db.recoveryMessage.count({ where: { ...unsent, attempts: { gte: 5 } } }),
    db.recoveryMessage.count({ where: { ...unsent, createdAt: { lte: new Date(now.getTime() - 5 * 60_000) } } }),
    db.recoveryMessage.findFirst({ where: unsent, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  return { pending, expired, exhausted, stuck, oldestAgeSeconds: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.createdAt.getTime()) / 1000)) : 0 };
}

export function recoverySenderFromEnv(): RecoverySender {
  const endpoint = process.env.AUTH_RECOVERY_WEBHOOK_URL;
  if (endpoint) {
    const url = new URL(endpoint);
    const secret = process.env.AUTH_RECOVERY_WEBHOOK_SECRET ?? '';
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || secret.length < 32) {
      throw new Error('Recovery delivery requires an HTTPS webhook and a strong webhook secret');
    }
    return async (message, id) => {
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, 'Idempotency-Key': id },
        body: JSON.stringify(message) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Recovery delivery failed');
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
