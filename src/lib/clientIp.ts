/**
 * The client address a limiter may key on, derived WITHOUT trusting anything a client can write (BUGHOUSE_SPEC.md HP11; used by the `join_challenge` attempt limiter).
 *
 * WHAT THE APP TRUSTS TODAY. Express has no `trust proxy` setting (src/index.ts) and socket.io's `socket.handshake.address` is the TCP peer, so both already trust exactly one
 * thing: the address of the connection's other end. Behind a platform proxy (Render) that peer is the PROXY, so every user would share one address - a per-address limit would
 * then be one global counter (any 30 failed guesses would lock everybody out). Render's proxy also does not strip a client-supplied `X-Forwarded-For` (it appends its own entry),
 * so the LEFTMOST entry is attacker-controlled and must never be used.
 *
 * THE DERIVATION (`clientIpOf`), in order:
 *   1. `trustedHops === 0` (the default outside production, and an explicit 0): the TCP peer. Nothing a header says is read.
 *   2. The peer is NOT a private / loopback / link-local address: the TCP peer. A connection that comes straight from the internet is not behind our proxy, so its
 *      `X-Forwarded-For` is whatever the client wrote and is ignored (this is what stops a direct client from choosing its own address).
 *   3. Otherwise (a private peer = a proxy inside the platform's network) the entry that is `trustedHops` places from the RIGHT of `X-Forwarded-For`: with one trusted proxy that
 *      is the entry the proxy itself appended, the address it saw. Entries that are not IP addresses are skipped; fewer entries than hops, or none: the TCP peer.
 * `trustedHops` defaults to 1 when NODE_ENV is "production" and 0 otherwise, and `TRUSTED_PROXY_HOPS=<0..5>` overrides it. If a platform puts two proxies in front (for example a CDN
 * in front of the load balancer) the right value is 2; the first deployment must be checked (two users on different networks must not share a counter) - see TESTING.md.
 *
 * This module is pure, reads no environment (the caller passes the number) and logs nothing.
 */
import { isIP } from 'node:net';

/** `::ffff:10.0.0.5` -> `10.0.0.5`; anything else unchanged (lower-cased). */
export function normalizeAddress(address: string): string {
  const lower = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  return mapped ? mapped[1] : lower;
}

/** Loopback, RFC 1918, link-local, carrier-grade NAT and unique-local IPv6: addresses a connection from the PUBLIC internet cannot have. */
export function isPrivateAddress(address: string): boolean {
  const a = normalizeAddress(address);
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number);
    return p === 10 || p === 127 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254) || (p === 100 && q >= 64 && q <= 127);
  }
  if (isIP(a) === 6) return a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb');
  return false;
}

export interface ClientIpSource {
  /** The TCP peer (`socket.handshake.address`). */
  peer: string;
  /** The raw `X-Forwarded-For` header value, if any. */
  forwardedFor?: string | string[] | undefined;
}

export function clientIpOf(source: ClientIpSource, trustedHops: number): string {
  const peer = normalizeAddress(source.peer ?? '');
  if (!(trustedHops >= 1) || !isPrivateAddress(peer)) return peer;
  const header = Array.isArray(source.forwardedFor) ? source.forwardedFor.join(',') : source.forwardedFor;
  if (!header) return peer;
  const entries = header
    .split(',')
    .map((part) => normalizeAddress(part))
    .filter((part) => isIP(part) !== 0);
  if (entries.length < trustedHops) return peer;
  return entries[entries.length - trustedHops];
}

/** The hop count: `TRUSTED_PROXY_HOPS` when it is a whole number 0..5, else 1 in production and 0 elsewhere. */
export function resolveTrustedHops(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS;
  if (raw !== undefined && /^[0-5]$/.test(raw)) return Number(raw);
  return env.NODE_ENV === 'production' ? 1 : 0;
}
