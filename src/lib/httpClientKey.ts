/**
 * The client address on the HTTP side, derived by the SAME rule as the sockets' (src/lib/clientIp.ts `clientIpOf`): the hop count from `TRUSTED_PROXY_HOPS` (1 in production, 0
 * elsewhere), the header read from the RIGHT and only behind a private peer. Used by the HTTP rate limiters (a `keyGenerator`) and by the diagnostic `GET /health/client-ip`.
 *
 * WHY NOT JUST `req.ip`. `app.set('trust proxy', <hops>)` (a NUMBER, never `true`: `true` takes the leftmost entry, which a client can write) makes Express's `req.ip` right behind
 * the platform's proxy, and src/index.ts sets it. But Express's rule has two edges that the sockets' rule closes: a PUBLIC peer's `X-Forwarded-For` is still believed, so a
 * client connecting straight to the server could choose its own address; and with fewer entries than hops it returns the leftmost entry instead of the peer. The limiters therefore
 * key on `derivedClientIp`, which is `clientIpOf` itself - one rule for HTTP and sockets - and test-trust-proxy.mjs proves the two agree wherever Express's number is safe and pins
 * the two edges where they differ.
 *
 * The key is passed through `ipKeyGenerator`, which leaves an IPv4 address alone and collapses an IPv6 address to its /56 so that one subscriber cannot dodge a limit by rotating
 * addresses inside their own prefix.
 */
import { isIP } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { clientIpOf, isPrivateAddress, normalizeAddress } from './clientIp.js';

/** The caller's address: `clientIpOf` over the TCP peer and the `X-Forwarded-For` header. */
export function derivedClientIp(req: Pick<Request, 'socket' | 'headers'>, hops: number): string {
  return clientIpOf({ peer: req.socket?.remoteAddress ?? '', forwardedFor: req.headers?.['x-forwarded-for'] }, hops);
}

/** The key a limiter counts under: the derived address, IPv6 collapsed to its /56. */
export function limiterKeyOf(address: string): string {
  return ipKeyGenerator(address);
}

/** A `keyGenerator` for `express-rate-limit`. */
export function httpKeyGenerator(hops: number): (req: Request) => string {
  return (req) => limiterKeyOf(derivedClientIp(req, hops));
}

export interface ClientIpDiagnostic {
  /** The caller's own address as the server derives it (what every limiter counts under, before the IPv6 /56 collapse). */
  clientIp: string;
  /** How many comma-separated entries the caller's `X-Forwarded-For` has (0 if none) - the number that tells which hop count is right. */
  xffEntries: number;
  /** Whether the TCP peer is a private / loopback / link-local address (a proxy inside the platform's network). */
  peerIsPrivate: boolean;
  /** The configured number of trusted proxy hops. */
  hops: number;
  /** Whether the DERIVED address is a private / loopback / link-local one. In production that means the hop count is too LOW: the entry taken is still one of the platform's own proxies. */
  clientIsPrivate: boolean;
  /** The kind of each `X-Forwarded-For` entry, left to right (at most the LAST ENTRY_CLASSES_SHOWN of them) - never an address. With the platform's chain this reads, for a request that
   * sent no header of its own, [public, public, private] on Render (client, Cloudflare edge, Render's own proxy), and the client is the entry `hops` places from the right. */
  chain: EntryClass[];
}

export type EntryClass = 'public' | 'private' | 'invalid';
export const ENTRY_CLASSES_SHOWN = 8;

/** The kind of every comma-separated entry of an `X-Forwarded-For` value (array headers joined first), without keeping the entry. */
export function classifyEntries(header: string | string[] | undefined): EntryClass[] {
  const joined = Array.isArray(header) ? header.join(',') : header ?? '';
  return joined
    .split(',')
    .filter((part) => part.trim() !== '')
    .map((part): EntryClass => {
      const address = normalizeAddress(part);
      if (isIP(address) === 0) return 'invalid';
      return isPrivateAddress(address) ? 'private' : 'public';
    });
}

/**
 * What `GET /health/client-ip` answers: ONLY the requester's own derived address, three counts/flags and the KIND of each header entry - no address from the header is echoed, no
 * other user's data exists in it, and the handler logs nothing. It is a diagnostic for checking the hop count after a deploy (BUGHOUSE_SPEC.md W9 may remove it).
 */
export function describeClientIp(req: Pick<Request, 'socket' | 'headers'>, hops: number): ClientIpDiagnostic {
  const header = req.headers?.['x-forwarded-for'];
  const joined = Array.isArray(header) ? header.join(',') : header ?? '';
  const xffEntries = joined.split(',').filter((part) => part.trim() !== '').length;
  const clientIp = derivedClientIp(req, hops);
  return {
    clientIp,
    xffEntries,
    peerIsPrivate: isPrivateAddress(req.socket?.remoteAddress ?? ''),
    hops,
    clientIsPrivate: isPrivateAddress(clientIp),
    chain: classifyEntries(header).slice(-ENTRY_CLASSES_SHOWN),
  };
}
