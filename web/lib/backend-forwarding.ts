import {timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';

const hexKey = /^[a-fA-F0-9]{64}$/;
export const validSessionToken = (value:unknown):value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

// This server-only module is imported by the BFF, never a client component.
// The HTTPS ingress overwrites both headers. Direct browser traffic cannot
// supply trusted identity without the independently configured 256-bit token.
export function backendRequestHeaders(incoming:Headers, sessionToken:string|undefined, proxyToken:string|undefined):Headers {
  const headers = new Headers({'Accept':'application/json','Content-Type':'application/json'});
  if (validSessionToken(sessionToken)) headers.set('Authorization', `Bearer ${sessionToken}`);
  const key = incoming.get('idempotency-key');
  if (key && /^[\w-]{16,128}$/.test(key)) headers.set('Idempotency-Key', key);

  const proof = incoming.get('x-tropa-proxy-token');
  const ip = incoming.get('x-real-ip');
  if (proxyToken && hexKey.test(proxyToken) && proof && hexKey.test(proof)
      && timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(proxyToken, 'hex'))
      && ip && ip.length <= 45 && !ip.includes('%') && isIP(ip) !== 0) {
    headers.set('X-Real-IP', ip);
    headers.set('X-Tropa-Proxy-Token', proxyToken.toLowerCase());
  }
  return headers;
}

// Only this bounded public response header crosses the proxy. Upstream cookies,
// network details and internal forwarding proofs are never copied to a client.
export function backendResponseHeaders(upstream:Headers):Headers {
  const headers = new Headers({'Cache-Control':'no-store','Vary':'Cookie'});
  const retry = upstream.get('retry-after');
  if (retry && /^\d{1,4}$/.test(retry) && Number(retry) >= 1 && Number(retry) <= 3600) headers.set('Retry-After', retry);
  return headers;
}
