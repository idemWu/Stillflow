import type { IMediaFormat, IMediaInfo } from '../shared/types.js';
import { detectPlatform, matchesPlatformHost } from '../shared/platforms.js';
import { AppError } from './errors.js';
import { assertPublicMediaUrl } from './security.js';

type UnknownRecord = Record<string, unknown>;
type PublicUrlValidator = (rawUrl: unknown) => Promise<URL>;

export interface IKuaishouProbeResult {
  canonicalUrl: string;
  downloadUrl: string;
  media: IMediaInfo;
}

export interface IKuaishouResolverDependencies {
  fetchImpl?: typeof fetch;
  validatePublicUrl?: PublicUrlValidator;
}

export const KUAISHOU_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// chenzhongtech.com is Kuaishou's own mobile redirect hop; it is never accepted
// as an initial platform URL, but must be checked while expanding v.kuaishou.com.
const PAGE_HOSTS = ['kuaishou.com', 'kuaishou.cn', 'chenzhongtech.com'];
const MEDIA_HOSTS = ['kwaicdn.com', 'yximgs.com'];
const APOLLO_MARKER = 'window.__APOLLO_STATE__=';
const MAX_REDIRECTS = 5;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_COOKIE_HEADER_BYTES = 4_096;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hasAllowedHost(hostname: string, hosts: readonly string[]): boolean {
  const normalized = hostname.toLowerCase().replace(/^www\./, '');
  return hosts.some((candidate) => matchesPlatformHost(normalized, candidate));
}

async function assertKuaishouPageUrl(
  rawUrl: unknown,
  validatePublicUrl: PublicUrlValidator,
): Promise<URL> {
  const parsed = await validatePublicUrl(rawUrl);
  if (parsed.protocol !== 'https:' || !hasAllowedHost(parsed.hostname, PAGE_HOSTS)) {
    throw new AppError('UNSUPPORTED', 422);
  }
  return parsed;
}

export async function assertTrustedKuaishouMediaUrl(
  rawUrl: unknown,
  validatePublicUrl: PublicUrlValidator = assertPublicMediaUrl,
): Promise<URL> {
  const parsed = await validatePublicUrl(rawUrl);
  if (parsed.protocol !== 'https:' || !hasAllowedHost(parsed.hostname, MEDIA_HOSTS)) {
    throw new AppError('UNSUPPORTED', 422);
  }
  return parsed;
}

export interface IKuaishouMediaFetchOptions extends IKuaishouResolverDependencies {
  referer: string;
  userAgent?: string;
  signal: AbortSignal;
}

/** Fetches a public Kuaishou media response without delegating redirects to a downloader. */
export async function fetchTrustedKuaishouMedia(
  rawUrl: unknown,
  options: IKuaishouMediaFetchOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const validatePublicUrl = options.validatePublicUrl ?? assertPublicMediaUrl;
  let currentUrl: URL;
  try {
    currentUrl = new URL(String(rawUrl));
  } catch {
    throw new AppError('INVALID_URL', 400);
  }

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const safeUrl = await assertTrustedKuaishouMediaUrl(currentUrl.href, validatePublicUrl);
    let response: Response;
    try {
      response = await fetchImpl(safeUrl, {
        redirect: 'manual',
        headers: {
          Accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
          Referer: options.referer,
          'User-Agent': options.userAgent ?? KUAISHOU_USER_AGENT,
        },
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) throw error;
      throw new AppError('NETWORK_ERROR', 502);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new AppError('DOWNLOAD_FAILED', 502);
      }
      try {
        currentUrl = new URL(location, safeUrl);
      } catch {
        throw new AppError('DOWNLOAD_FAILED', 502);
      }
      continue;
    }

    if (!response.ok || response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw response.ok
        ? new AppError('DOWNLOAD_FAILED', 502)
        : classifyPageStatus(response.status);
    }

    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const pathLooksLikeMp4 = safeUrl.pathname.toLowerCase().endsWith('.mp4');
    if (contentType !== 'video/mp4' && !(contentType === 'application/octet-stream' && pathLooksLikeMp4)) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError('DOWNLOAD_FAILED', 502);
    }
    return response;
  }

  throw new AppError('DOWNLOAD_FAILED', 502);
}

function parseEmbeddedObject(source: string, marker: string): UnknownRecord {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new AppError('UNAVAILABLE', 422);

  let start = markerIndex + marker.length;
  while (/\s/.test(source[start] ?? '')) start += 1;
  if (source[start] !== '{') throw new AppError('UNAVAILABLE', 422);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(source.slice(start, index + 1));
          const record = asRecord(parsed);
          if (record) return record;
        } catch {
          // Report a stable unavailable error below.
        }
        throw new AppError('UNAVAILABLE', 422);
      }
    }
  }
  throw new AppError('UNAVAILABLE', 422);
}

export function parseKuaishouApolloState(html: string): UnknownRecord {
  if (!html || html.length > MAX_PAGE_BYTES) throw new AppError('UNAVAILABLE', 422);
  return parseEmbeddedObject(html, APOLLO_MARKER);
}

async function readTextWithLimit(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAGE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new AppError('UNAVAILABLE', 422);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('UNAVAILABLE', 422);
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

function classifyPageStatus(status: number): AppError {
  if (status === 401 || status === 403) return new AppError('AUTH_REQUIRED', 403);
  if (status === 404 || status === 410) return new AppError('UNAVAILABLE', 404);
  if (status === 429) return new AppError('RATE_LIMITED', 429);
  return new AppError('NETWORK_ERROR', 502);
}

type AnonymousCookieJars = Map<string, Map<string, string>>;

function cookieScope(hostname: string): string | null {
  return PAGE_HOSTS.find((candidate) => matchesPlatformHost(hostname, candidate)) ?? null;
}

function cookieHeaderFor(url: URL, jars: AnonymousCookieJars): string {
  const scope = cookieScope(url.hostname);
  if (!scope) return '';
  return [...(jars.get(scope) ?? [])]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function updateAnonymousCookies(
  response: Response,
  responseUrl: URL,
  jars: AnonymousCookieJars,
): void {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const singleSetCookie = response.headers.get('set-cookie');
  const setCookies = headers.getSetCookie?.() ?? (singleSetCookie ? [singleSetCookie] : []);
  const responseScope = cookieScope(responseUrl.hostname);
  if (!responseScope) return;

  for (const value of setCookies) {
    const parts = value.split(';');
    const pair = parts[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || /[\u0000-\u001f\u007f;]/.test(cookieValue)) continue;
    const domainAttribute = parts
      .map((part) => part.trim())
      .find((part) => /^domain=/i.test(part));
    const cookieDomain = (domainAttribute?.slice(domainAttribute.indexOf('=') + 1) ?? responseUrl.hostname)
      .trim()
      .replace(/^\./, '')
      .toLowerCase();
    if (!matchesPlatformHost(responseUrl.hostname, cookieDomain)) continue;
    if (cookieScope(cookieDomain) !== responseScope) continue;

    let cookies = jars.get(responseScope);
    if (!cookies) {
      cookies = new Map<string, string>();
      jars.set(responseScope, cookies);
    }
    const shouldDelete = !cookieValue || parts.some((part) => /^max-age\s*=\s*0$/i.test(part.trim()));
    if (shouldDelete) cookies.delete(name);
    else cookies.set(name, cookieValue.slice(0, 1_024));
  }

  const cookies = jars.get(responseScope);
  while (cookies && [...cookies].map(([name, cookieValue]) => `${name}=${cookieValue}`).join('; ').length > MAX_COOKIE_HEADER_BYTES) {
    const oldest = cookies.keys().next().value;
    if (typeof oldest !== 'string') break;
    cookies.delete(oldest);
  }
}

async function fetchKuaishouPage(
  requestedUrl: URL,
  dependencies: Required<IKuaishouResolverDependencies>,
): Promise<{ canonicalUrl: URL; html: string; detailId: string }> {
  let currentUrl = requestedUrl;
  const anonymousCookies: AnonymousCookieJars = new Map();
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const safeUrl = await assertKuaishouPageUrl(currentUrl.href, dependencies.validatePublicUrl);
    let response: Response;
    try {
      const cookieHeader = cookieHeaderFor(safeUrl, anonymousCookies);
      response = await dependencies.fetchImpl(safeUrl, {
        redirect: 'manual',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          'User-Agent': KUAISHOU_USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const timedOut = name === 'AbortError' || name === 'TimeoutError';
      throw new AppError(timedOut ? 'PROBE_TIMEOUT' : 'NETWORK_ERROR', timedOut ? 504 : 502);
    }
    updateAnonymousCookies(response, safeUrl, anonymousCookies);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirectCount === MAX_REDIRECTS) throw new AppError('UNSUPPORTED', 422);
      try {
        currentUrl = new URL(location, safeUrl);
      } catch {
        throw new AppError('UNAVAILABLE', 422);
      }
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw classifyPageStatus(response.status);
    }

    const detailMatch = /^\/short-video\/([A-Za-z0-9_-]{6,128})\/?$/.exec(safeUrl.pathname);
    if (!detailMatch) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError('UNSUPPORTED', 422);
    }
    return {
      canonicalUrl: safeUrl,
      html: await readTextWithLimit(response),
      detailId: detailMatch[1],
    };
  }
  throw new AppError('UNSUPPORTED', 422);
}

function toPublishedDate(timestamp: number | null): string | null {
  if (!timestamp || timestamp <= 0) return null;
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10).replaceAll('-', '');
}

function toDurationSecondsFromMilliseconds(duration: number | null): number | null {
  return duration && duration > 0 ? duration / 1_000 : null;
}

async function optionalTrustedMediaUrl(
  value: unknown,
  validatePublicUrl: PublicUrlValidator,
): Promise<string | null> {
  const url = asString(value);
  if (!url) return null;
  try {
    return (await assertTrustedKuaishouMediaUrl(url, validatePublicUrl)).href;
  } catch {
    return null;
  }
}

export async function probeKuaishou(
  requestedUrl: URL,
  suppliedDependencies: IKuaishouResolverDependencies = {},
): Promise<IKuaishouProbeResult> {
  const dependencies: Required<IKuaishouResolverDependencies> = {
    fetchImpl: suppliedDependencies.fetchImpl ?? fetch,
    validatePublicUrl: suppliedDependencies.validatePublicUrl ?? assertPublicMediaUrl,
  };
  const page = await fetchKuaishouPage(requestedUrl, dependencies);
  const state = parseKuaishouApolloState(page.html);
  const clientState = asRecord(state.defaultClient);
  const photo = clientState ? asRecord(clientState[`VisionVideoDetailPhoto:${page.detailId}`]) : null;
  if (!clientState || !photo) {
    const blockedDetail = clientState
      ? Object.entries(clientState).find(([key, value]) => (
        key.startsWith('$ROOT_QUERY.visionVideoDetail(')
        && key.includes(page.detailId)
        && asNumber(asRecord(value)?.status) === 2
      ))
      : null;
    throw new AppError(blockedDetail ? 'AUTH_REQUIRED' : 'UNAVAILABLE', blockedDetail ? 403 : 422);
  }

  const rawDownloadUrl = asString(photo.photoUrl);
  if (!rawDownloadUrl) throw new AppError('UNSUPPORTED', 422);
  const downloadUrl = await assertTrustedKuaishouMediaUrl(
    new URL(rawDownloadUrl, page.canonicalUrl).href,
    dependencies.validatePublicUrl,
  );
  const thumbnailUrl = await optionalTrustedMediaUrl(photo.coverUrl, dependencies.validatePublicUrl);

  const photoKey = `VisionVideoDetailPhoto:${page.detailId}`;
  const detailEntry = Object.values(clientState).find((value) => {
    const detail = asRecord(value);
    const photoReference = asRecord(detail?.photo);
    return asString(photoReference?.id) === photoKey;
  });
  const authorReference = asRecord(asRecord(detailEntry)?.author);
  const referencedAuthorKey = asString(authorReference?.id);
  const authorEntries = Object.entries(clientState)
    .filter(([key, value]) => key.startsWith('VisionVideoDetailAuthor:') && asRecord(value));
  const author = referencedAuthorKey
    ? asRecord(clientState[referencedAuthorKey])
    : authorEntries.length === 1 ? asRecord(authorEntries[0][1]) : null;
  const caption = asString(photo.caption);
  const title = (caption ?? `快手视频 ${page.detailId}`).slice(0, 300);
  const width = asNumber(photo.width);
  const height = asNumber(photo.height);
  const quality = width && height ? Math.min(width, height) : height ?? width;
  const format: IMediaFormat = {
    id: 'source',
    label: quality ? `${Math.round(quality)}p` : '原始清晰度',
    resolution: width && height ? `${Math.round(width)} × ${Math.round(height)}` : '来源原画',
    width,
    height,
    fps: null,
    extension: 'MP4',
    codec: null,
    hasAudio: true,
    hdr: false,
    estimatedBytes: null,
  };
  const media: IMediaInfo = {
    id: page.detailId,
    title,
    description: caption,
    author: asString(author?.name) ?? asString(photo.userName),
    durationSeconds: toDurationSecondsFromMilliseconds(asNumber(photo.duration)),
    thumbnailUrl,
    publishedAt: toPublishedDate(asNumber(photo.timestamp)),
    viewCount: asNumber(photo.viewCount),
    platform: detectPlatform(requestedUrl.href),
    formats: [format],
    originalUrl: requestedUrl.href,
  };

  return {
    canonicalUrl: page.canonicalUrl.href,
    downloadUrl: downloadUrl.href,
    media,
  };
}
