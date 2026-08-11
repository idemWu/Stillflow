import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { AppError } from './errors.js';

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home', '.lan'];

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;

  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

export function validateUrlSyntax(rawUrl: unknown): URL {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0 || rawUrl.length > 4_096) {
    throw new AppError('INVALID_URL', 400);
  }

  if (/[\u0000-\u001f\u007f\\]/.test(rawUrl)) {
    throw new AppError('INVALID_URL', 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new AppError('INVALID_URL', 400);
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new AppError('INVALID_URL', 400);
  }

  if (parsed.port && !['80', '443'].includes(parsed.port)) {
    throw new AppError('INVALID_URL', 400);
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (
    !hostname ||
    hostname === 'localhost' ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new AppError('PRIVATE_ADDRESS', 403);
  }

  if (isIP(hostname) && isPrivateAddress(hostname)) {
    throw new AppError('PRIVATE_ADDRESS', 403);
  }

  parsed.hash = '';
  return parsed;
}

export async function assertPublicMediaUrl(rawUrl: unknown): Promise<URL> {
  const parsed = validateUrlSyntax(rawUrl);
  const hostname = normalizeHostname(parsed.hostname);

  if (isIP(hostname)) return parsed;

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError('NETWORK_ERROR', 502);
  }

  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new AppError('PRIVATE_ADDRESS', 403);
  }

  return parsed;
}

export function validateFormatId(value: unknown): string {
  if (value === 'best') return 'best';
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(value)) {
    throw new AppError('INVALID_URL', 400);
  }
  return value;
}
