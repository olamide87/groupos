import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { requireOrganizer, createAuthRouter, type AuthOptions } from './auth/routes.js';
import { AuthError, readAuthSettings } from './auth/security.js';
import { getDatabase } from './database.js';

export function createApp(options: AuthOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(cors({ origin: (origin, callback) => {
    if (!origin) return callback(null, false);
    try { callback(null, origin === (options.settings ?? readAuthSettings)().origin); }
    catch { callback(null, false); }
  }, credentials: true, allowedHeaders: ['Content-Type', 'X-GroupOS-Request'], methods: ['GET', 'POST'] }));
  app.use(express.json({ limit: '8kb', strict: true }));
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
  app.use('/api/v1/auth', createAuthRouter(options));

  // A read-only organizer route exercises the ownership boundary before event CRUD.
  app.get('/api/v1/events/:eventId', requireOrganizer(options), (req, res, next) => {
    (async () => {
      res.set('Cache-Control', 'no-store');
      const db = (options.database ?? getDatabase)();
      const user = res.locals.organizer;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.eventId)) throw new AuthError(404, 'Event not found');
      const event = await db.event.findFirst({ where: { id: req.params.eventId, organizerId: user.id },
        select: { id: true, title: true, description: true, location: true, startsAt: true, endsAt: true, timeZone: true, status: true } });
      if (!event) throw new AuthError(404, 'Event not found');
      res.json({ event });
    })().catch(next);
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'groupos-api' });
  });

  app.get('/api/v1', (_req, res) => {
    res.json({ name: 'GroupOS', version: '0.1.0', status: 'foundation' });
  });

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.set('Cache-Control', 'no-store');
    if (error instanceof AuthError) {
      if (error.status === 429) res.set('Retry-After', String(error.retryAfter ?? 3600));
      if (error.status === 503) res.set('Retry-After', '2');
      res.status(error.status).json({ error: error.message });
    } else if (error?.type === 'entity.too.large') res.status(413).json({ error: 'Request body is too large' });
    else if (error?.type === 'entity.parse.failed') res.status(400).json({ error: 'Invalid JSON' });
    else {
      console.error('API request failed');
      res.status(500).json({ error: 'Request could not be completed' });
    }
  };
  app.use(errors);
  return app;
}

export const app = createApp();
