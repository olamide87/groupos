import type { RequestHandler } from 'express';
import { AuthError, readAuthSettings, type AuthSettings } from './security.js';

export function requireSameOrigin(settings: () => AuthSettings = readAuthSettings): RequestHandler {
  return (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    try {
      if (req.get('origin') !== settings().origin || req.get('x-groupos-request') !== '1' || !req.is('application/json')) {
        throw new AuthError(403, 'Request origin or content type is not allowed');
      }
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new AuthError(400, 'A JSON object is required');
      next();
    } catch (error) { next(error); }
  };
}
