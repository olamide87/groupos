import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) { super(message); }
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');
export const validToken = (token: unknown): token is string => typeof token === 'string' && /^[0-9a-f]{64}$/.test(token);

// OWASP scrypt baseline: N=2^17, r=8, p=1. Bound concurrent memory use to ~256 MiB.
let activeHashes = 0;
async function derive(password: string, salt: string): Promise<Buffer> {
  if (activeHashes >= 2) throw new AuthError(503, 'Authentication is busy; try again shortly');
  activeHashes++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 },
        (error, value) => error ? reject(error) : resolve(value));
    });
  } finally { activeHashes--; }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$131072$8$1$${salt}$${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const match = stored?.match(/^scrypt\$131072\$8\$1\$([0-9a-f]{32})\$([0-9a-f]{128})$/);
  // Missing users perform the same expensive derivation as existing users.
  const actual = await derive(password, match?.[1] ?? '0'.repeat(32));
  const equal = timingSafeEqual(actual, Buffer.from(match?.[2] ?? '0'.repeat(128), 'hex'));
  return !!match && equal;
}

export function emailAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254) throw new AuthError(400, 'Enter a valid email address');
  const email = value.trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)) {
    throw new AuthError(400, 'Enter a valid email address');
  }
  return email;
}

export function passwordInput(value: unknown): string {
  if (typeof value !== 'string' || value.length < 15 || value.length > 128 || Buffer.byteLength(value) > 512) {
    throw new AuthError(400, 'Use a password of 15–128 characters');
  }
  return value;
}

export interface AuthSettings { origin: string; secureCookies: boolean; recoveryKey: Buffer }
export function readAuthSettings(): AuthSettings {
  const production = process.env.NODE_ENV === 'production';
  const origin = process.env.AUTH_ORIGIN ?? (production ? '' : 'http://localhost:3000');
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error('AUTH_ORIGIN must be an explicit origin'); }
  if (origin !== parsed.origin || !['http:', 'https:'].includes(parsed.protocol)
      || (production && parsed.protocol !== 'https:')) throw new Error('AUTH_ORIGIN must be an origin; production requires HTTPS');
  const key = process.env.AUTH_RECOVERY_KEY ?? '';
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('AUTH_RECOVERY_KEY must contain 32 random bytes encoded as hex');
  return { origin, secureCookies: production || parsed.protocol === 'https:', recoveryKey: Buffer.from(key, 'hex') };
}

export function encryptRecovery(value: object, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

export function decryptRecovery(message: { ciphertext: string; iv: string; tag: string }, key: Buffer): unknown {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(message.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(message.tag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(message.ciphertext, 'hex')), decipher.final()]).toString('utf8'));
}
