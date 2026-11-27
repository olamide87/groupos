import type { PrismaClient } from '@prisma/client';
import { AuthError, hashToken } from './security.js';

export interface RatePolicy { ip: number; account: number; windowMs: number }
export const defaultPolicies: Record<string, RatePolicy> = {
  signup: { ip: 20, account: 5, windowMs: 60 * 60_000 },
  login: { ip: 30, account: 10, windowMs: 15 * 60_000 },
  forgot: { ip: 15, account: 5, windowMs: 60 * 60_000 },
  reset: { ip: 20, account: 10, windowMs: 15 * 60_000 },
};

export async function consumeRateLimit(db: PrismaClient, action: string, peer: string, account: string,
  policy: RatePolicy, now = new Date()): Promise<void> {
  const bucket = Math.floor(now.getTime() / policy.windowMs);
  const expiresAt = new Date((bucket + 1) * policy.windowMs);
  await db.authRateLimit.deleteMany({ where: { expiresAt: { lte: now } } });
  for (const [kind, value, limit] of [['ip', peer, policy.ip], ['account', account, policy.account]] as const) {
    const keyHash = hashToken(`${action}:${kind}:${value}:${bucket}`);
    const row = await db.authRateLimit.upsert({
      where: { keyHash }, create: { keyHash, expiresAt }, update: { count: { increment: 1 } },
    });
    if (row.count > limit) throw new AuthError(429, 'Too many attempts; try again later', Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000)));
  }
}
