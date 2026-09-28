import * as net from 'node:net';
import { classifyIp } from './ip.js';

export interface ValidatedUrl {
  originalUrl: string;
  normalizedUrl: string;
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  pathname: string;
  search: string;
  isDirectIp: boolean;
  directIp?: string;
}

const LOCAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'broadcasthost',
  'local',
  'internal',
  'lan'
]);

export function validateUrlSyntax(inputUrl: string): ValidatedUrl {
  if (typeof inputUrl !== 'string' || inputUrl.trim().length === 0) {
    throw new Error('URL cannot be empty');
  }

  const trimmed = inputUrl.trim();

  // Reject URLs with embedded control characters or spaces
  if (/[\x00-\x1F\x7F\s]/.test(trimmed)) {
    throw new Error('URL contains invalid control characters or whitespace');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    throw new Error(`Invalid URL format: ${(err as Error).message}`);
  }

  // Scheme policy: strictly http: or https:
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Prohibited protocol: ${parsed.protocol}. Only http: and https: are allowed.`);
  }

  // Credential policy: reject username or password
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials (username/password) are prohibited');
  }

  // Hostname checks
  let hostname = parsed.hostname.toLowerCase();

  // Strip trailing dot if present for FQDN
  if (hostname.endsWith('.')) {
    hostname = hostname.slice(0, -1);
  }

  if (!hostname || hostname.length === 0) {
    throw new Error('URL hostname is empty');
  }

  // Reject localhost and mDNS/internal local domain patterns
  if (
    LOCAL_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.home.arpa')
  ) {
    throw new Error(`Prohibited local/internal hostname: ${hostname}`);
  }

  // Port policy: strictly 80 or 443
  let port: number;
  if (parsed.port) {
    port = Number.parseInt(parsed.port, 10);
    if (Number.isNaN(port) || (port !== 80 && port !== 443)) {
      throw new Error(`Prohibited port: ${parsed.port}. Only ports 80 and 443 are allowed.`);
    }
  } else {
    port = parsed.protocol === 'https:' ? 443 : 80;
  }

  // Check if hostname is an IP (handling IPv6 brackets)
  const cleanIpCandidate = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  const isDirectIp = net.isIP(cleanIpCandidate) !== 0;

  if (isDirectIp) {
    const classification = classifyIp(cleanIpCandidate);
    if (!classification.isPublic) {
      throw new Error(`Prohibited direct IP address: ${classification.reason || cleanIpCandidate}`);
    }
  } else {
    // If it's a hostname, make sure it doesn't try numeric IP bypasses that failed net.isIP
    // e.g. 0x7f000001 or 2130706433 or octal strings
    if (/^(0x[0-9a-f]+|\d+)$/i.test(hostname)) {
      throw new Error(`Prohibited raw numeric/hex hostname representation: ${hostname}`);
    }
  }

  // Normalized URL
  const normalizedUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;

  return {
    originalUrl: inputUrl,
    normalizedUrl,
    protocol: parsed.protocol as 'http:' | 'https:',
    hostname,
    port,
    pathname: parsed.pathname,
    search: parsed.search,
    isDirectIp,
    directIp: isDirectIp ? cleanIpCandidate : undefined
  };
}
