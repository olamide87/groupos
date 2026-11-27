import { isIP } from 'node:net';
import type { Request, RequestHandler } from 'express';
import { AuthError } from './auth/security.js';

export type ProxyPolicy = { mode: 'direct' } | { mode: 'trusted'; chain: string[]; host: string };
const identities = new WeakMap<Request, string>();

export function canonicalIp(value: string): string {
  if (!isIP(value)) throw new Error('Invalid IP address');
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
  if (mapped) {
    const n = parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16);
    return [24, 16, 8, 0].map(shift => (n >>> shift) & 255).join('.');
  }
  return normalized;
}

export function readProxyPolicy(env = process.env): ProxyPolicy {
  const mode = env.API_PROXY_MODE ?? (env.NODE_ENV === 'production' ? '' : 'direct');
  if (mode === 'direct' && !env.API_TRUSTED_PROXY_CHAIN) return { mode };
  if (mode !== 'trusted') throw new Error('Explicit API proxy configuration required');
  const chain: unknown = JSON.parse(env.API_TRUSTED_PROXY_CHAIN ?? 'null');
  if (!Array.isArray(chain) || chain.length < 1 || chain.length > 3 || chain.some(ip => typeof ip !== 'string')) {
    throw new Error('Configure one to three exact proxy addresses, nearest first');
  }
  const normalized = chain.map(canonicalIp);
  if (new Set(normalized).size !== normalized.length || normalized.some(ip => ['0.0.0.0', '::'].includes(ip))) {
    throw new Error('Ambiguous proxy chain');
  }
  const origin = new URL(env.AUTH_ORIGIN ?? '');
  if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN) throw new Error('Trusted mode requires an exact HTTPS origin');
  return { mode, chain: normalized, host: origin.host };
}

export const clientIp = (req: Request) => identities.get(req) ?? canonicalIp(req.socket.remoteAddress ?? '');

export function enforceProxyBoundary(policy: ProxyPolicy): RequestHandler {
  return (req, _res, next) => {
    try {
      const peer = canonicalIp(req.socket.remoteAddress ?? '');
      if (policy.mode === 'direct') {
        // Deliberately ignore every forwarded identity, including Next.js rewrites.
        identities.set(req, peer); next(); return;
      }
      if (peer !== policy.chain[0]) throw new Error('Untrusted peer');
      const single = (name: string) => {
        const count = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length;
        const value = req.headers[name];
        if (count !== 1 || typeof value !== 'string') throw new Error('Missing or duplicate forwarding header');
        return value;
      };
      if (req.headers.forwarded !== undefined || req.headers['x-real-ip'] !== undefined
          || req.headers['x-forwarded-port'] !== undefined) throw new Error('Ambiguous forwarding headers');
      const chain = single('x-forwarded-for').split(',').map(ip => canonicalIp(ip.trim()));
      if (chain.length !== policy.chain.length || single('x-forwarded-proto') !== 'https'
          || single('x-forwarded-host') !== policy.host
          || chain.slice(1).reverse().some((ip, i) => ip !== policy.chain[i + 1])
          || policy.chain.includes(chain[0])) throw new Error('Unexpected proxy path');
      identities.set(req, chain[0]); next();
    } catch { next(new AuthError(400, 'Invalid request network path')); }
  };
}
