// Trust the client IP supplied by Vercel's infrastructure ONLY when the actual
// deployment environment identifies itself as Vercel. A user-controlled
// X-Forwarded-For header is not trusted in local or other Node hosting modes.
import {isIP} from 'node:net';
import {HttpError} from './validators.mjs';

export function requestIP(req, cfg={}) {
  if (cfg.vercelRuntime === true) {
    // Vercel documents x-vercel-forwarded-for as its client-IP header; Vercel
    // populates the value, and it remains distinct from a custom proxy's XFF.
    const value=req.headers?.['x-vercel-forwarded-for'];
    if (typeof value !== 'string' || value.length > 200) {
      throw new HttpError(503, 'Trusted client identity unavailable');
    }
    const first=value.split(',')[0]?.trim();
    if (!first || !isIP(first)) {
      throw new HttpError(503, 'Trusted client identity unavailable');
    }
    return first;
  }
  const ip=req.socket?.remoteAddress;
  return typeof ip === 'string' && isIP(ip) ? ip : 'unknown';
}
