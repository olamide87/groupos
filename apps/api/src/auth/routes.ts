import { Router, type Request, type Response, type RequestHandler } from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getDatabase } from '../database.js';
import { AuthError, emailAddress, encryptRecovery, hashPassword, hashToken, newToken, passwordInput,
  readAuthSettings, validToken, verifyPassword, type AuthSettings } from './security.js';
import { consumeRateLimit, defaultPolicies, type RatePolicy } from './rate-limit.js';
import { requireSameOrigin } from './csrf.js';
import { clientIp } from '../proxy.js';

export interface AuthOptions {
  database?: () => PrismaClient;
  settings?: () => AuthSettings;
  policies?: Record<string, RatePolicy>;
}
const SESSION_MS = 60 * 60_000;
const RESET_MS = 30 * 60_000;
const publicUser = (user: { id: string; email: string; name: string }) => ({ id: user.id, email: user.email, name: user.name });
const cookieName = (settings: AuthSettings) => settings.secureCookies ? '__Host-groupos_session' : 'groupos_session';
const cookieOptions = (settings: AuthSettings) => ({ httpOnly: true, secure: settings.secureCookies, sameSite: 'strict' as const, path: '/' });

export function sessionToken(req: Request, settings: AuthSettings): string | undefined {
  const values = (req.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${cookieName(settings)}=`));
  if (values.length !== 1) return;
  const value = values[0].slice(cookieName(settings).length + 1);
  return validToken(value) ? value : undefined;
}

export async function authenticate(req: Request, db: PrismaClient, settings: AuthSettings) {
  const token = sessionToken(req, settings);
  if (!token) throw new AuthError(401, 'Sign in to continue');
  const session = await db.authSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!session || session.expiresAt <= new Date() || session.authVersion !== session.user.authVersion || !session.user.passwordHash) {
    throw new AuthError(401, 'Sign in to continue');
  }
  return session.user;
}

export function requireOrganizer(options: AuthOptions = {}): RequestHandler {
  return (req, res, next) => {
    Promise.resolve().then(() => authenticate(req, (options.database ?? getDatabase)(), (options.settings ?? readAuthSettings)()))
      .then(user => { res.locals.organizer = publicUser(user); next(); }, next);
  };
}

export function createAuthRouter(options: AuthOptions = {}): Router {
  const router = Router();
  const database = options.database ?? getDatabase;
  const settings = options.settings ?? readAuthSettings;
  const policies = options.policies ?? defaultPolicies;
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); });
  router.use(requireSameOrigin(settings));
  const action = (name: string, handler: (req: Request, res: Response, db: PrismaClient, config: AuthSettings) => Promise<void>) =>
    router.post(`/${name}`, (req, res, next) => {
      (async () => {
        const db = database();
        const policy = policies[name];
        if (policy) {
          // Only the validated network boundary supplies the limiter identity.
          const account = name === 'reset' && validToken(req.body.token) ? hashToken(req.body.token)
            : typeof req.body.email === 'string' && req.body.email.length <= 254 ? req.body.email.trim().toLowerCase() : `(invalid:${clientIp(req)})`;
          await consumeRateLimit(db, name, clientIp(req), account, policy);
        }
        await handler(req, res, db, settings());
      })().catch(next);
    });

  action('signup', async (req, res, db) => {
    const email = emailAddress(req.body.email);
    const password = passwordInput(req.body.password);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 120) throw new AuthError(400, 'Enter a name of 1–120 characters');
    const passwordHash = await hashPassword(password);
    try {
      await db.$transaction(async tx => {
        const user = await tx.user.create({ data: { email, name, passwordHash } });
        await tx.auditEntry.create({ data: { actorUserId: user.id, action: 'auth.signup', entityType: 'User', entityId: user.id } });
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    }
    // A duplicate cannot overwrite credentials or reveal whether an address is registered.
    res.status(202).json({ message: 'If this address can be registered, your account is ready. Sign in or recover access.' });
  });

  action('login', async (req, res, db, config) => {
    const email = emailAddress(req.body.email);
    const password = passwordInput(req.body.password);
    const candidate = await db.user.findUnique({ where: { email } });
    const verified = await verifyPassword(password, candidate?.passwordHash ?? null);
    if (!candidate || !verified) throw new AuthError(401, 'Email or password is incorrect');
    const token = newToken();
    const user = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${candidate.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({ where: { id: candidate.id } });
      if (current.passwordHash !== candidate.passwordHash || current.authVersion !== candidate.authVersion) {
        throw new AuthError(401, 'Email or password is incorrect');
      }
      const old = sessionToken(req, config);
      if (old) await tx.authSession.deleteMany({ where: { tokenHash: hashToken(old) } });
      await tx.authSession.deleteMany({ where: { userId: current.id, expiresAt: { lte: new Date() } } });
      await tx.authSession.create({ data: { tokenHash: hashToken(token), userId: current.id, authVersion: current.authVersion, expiresAt: new Date(Date.now() + SESSION_MS) } });
      await tx.auditEntry.create({ data: { actorUserId: current.id, action: 'auth.login', entityType: 'User', entityId: current.id } });
      return current;
    });
    res.cookie(cookieName(config), token, { ...cookieOptions(config), maxAge: SESSION_MS });
    res.json({ user: publicUser(user) });
  });

  action('logout', async (req, res, db, config) => {
    const token = sessionToken(req, config);
    if (token) await db.authSession.deleteMany({ where: { tokenHash: hashToken(token) } });
    res.clearCookie(cookieName(config), cookieOptions(config));
    res.status(204).end();
  });

  action('forgot', async (req, res, db, config) => {
    const started = performance.now();
    const email = emailAddress(req.body.email);
    const user = await db.user.findUnique({ where: { email } });
    if (user?.passwordHash) {
      const raw = newToken();
      const tokenHash = hashToken(raw);
      const expiresAt = new Date(Date.now() + RESET_MS);
      // Fragment keeps the bearer token out of HTTP access logs and Referer headers.
      const encrypted = encryptRecovery({ email, resetUrl: `${config.origin}/account#reset=${raw}`, expiresAt: expiresAt.toISOString() }, config.recoveryKey);
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id}::uuid FOR UPDATE`;
        await tx.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
        await tx.passwordReset.create({ data: { tokenHash, userId: user.id, expiresAt, message: { create: encrypted } } });
      });
    }
    // Network delivery is never awaited here, preventing delivery latency from exposing accounts.
    await delay(Math.max(0, 500 - (performance.now() - started)));
    res.status(202).json({ message: 'If an account exists, password reset instructions have been queued.' });
  });

  action('reset', async (req, res, db, config) => {
    if (!validToken(req.body.token)) throw new AuthError(400, 'Reset link is invalid or expired');
    const tokenHash = hashToken(req.body.token);
    const candidate = await db.passwordReset.findUnique({ where: { tokenHash } });
    if (!candidate || candidate.usedAt || candidate.expiresAt <= new Date()) throw new AuthError(400, 'Reset link is invalid or expired');
    const passwordHash = await hashPassword(passwordInput(req.body.password));
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${candidate.userId}::uuid FOR UPDATE`;
      const consumed = await tx.passwordReset.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) throw new AuthError(400, 'Reset link is invalid or expired');
      await tx.user.update({ where: { id: candidate.userId }, data: { passwordHash, authVersion: { increment: 1 } } });
      await tx.authSession.deleteMany({ where: { userId: candidate.userId } });
      await tx.passwordReset.updateMany({ where: { userId: candidate.userId, usedAt: null }, data: { usedAt: new Date() } });
      await tx.auditEntry.create({ data: { actorUserId: candidate.userId, action: 'auth.password-reset', entityType: 'User', entityId: candidate.userId } });
    });
    res.clearCookie(cookieName(config), cookieOptions(config));
    res.json({ message: 'Password updated. Sign in with your new password.' });
  });

  router.get('/me', requireOrganizer(options), (_req, res) => { res.json({ user: res.locals.organizer }); });
  return router;
}
