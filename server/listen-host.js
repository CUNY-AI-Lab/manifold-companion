import { BlockList, isIP } from 'node:net';

export const DEFAULT_LISTEN_HOST = '127.0.0.1';

const WILDCARD_ADDRESSES = new BlockList();
WILDCARD_ADDRESSES.addAddress('0.0.0.0', 'ipv4');
WILDCARD_ADDRESSES.addAddress('::', 'ipv6');

function isWildcardHost(host) {
  const family = isIP(host);
  if (family === 4) return WILDCARD_ADDRESSES.check(host, 'ipv4');
  if (family === 6) return WILDCARD_ADDRESSES.check(host, 'ipv6');
  return false;
}

/**
 * Resolve the TCP bind host without relying on Node's unsafe omitted-host
 * default (`::` or `0.0.0.0`). Explicit wildcard addresses are rejected so a
 * reverse-proxied production service cannot be exposed by an env typo.
 */
export function resolveListenHost(value = process.env.HOST) {
  const host = typeof value === 'string' ? value.trim() : '';

  if (!host) return DEFAULT_LISTEN_HOST;
  if (isWildcardHost(host)) {
    throw new Error('HOST must not be a wildcard address; use a specific interface');
  }

  if (host !== 'localhost' && isIP(host) === 0) {
    throw new Error('HOST must be localhost or a valid IP address');
  }

  return host;
}
