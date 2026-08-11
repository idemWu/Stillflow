import { randomUUID } from 'node:crypto';
import type { IMediaInfo } from '../shared/types.js';
import { extractVideoUrlFromText } from '../shared/linkInput.js';
import { AppError, classifyEngineError } from './errors.js';
import { requireEngine, runEngineCapture } from './engine.js';
import { KUAISHOU_USER_AGENT, probeKuaishou } from './kuaishou.js';
import { normalizeMediaInfo } from './media.js';
import { detectPlatform } from './platform.js';
import { assertPublicMediaUrl } from './security.js';

interface IStoredOption {
  rawFormatId: string;
  hasAudio: boolean;
}

export interface IProbeRecord {
  id: string;
  url: string;
  sourceId: string;
  media: IMediaInfo;
  options: Map<string, IStoredOption>;
  downloadSource: {
    mode: 'extractor' | 'direct';
    url: string;
    referer: string | null;
    userAgent: string | null;
  };
  expiresAt: number;
}

const PROBE_TTL_MS = 10 * 60 * 1_000;
const probes = new Map<string, IProbeRecord>();

function assertAllowedSource(rawData: unknown, url: string): void {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    throw new AppError('UNAVAILABLE', 422);
  }

  const data = rawData as Record<string, unknown>;
  const platform = detectPlatform(url);
  const extractor = typeof data.extractor_key === 'string' ? data.extractor_key.toLowerCase() : '';
  const availability = typeof data.availability === 'string' ? data.availability.toLowerCase() : '';
  const type = typeof data._type === 'string' ? data._type.toLowerCase() : '';

  if (platform.id === 'other' || extractor === 'generic') {
    throw new AppError('UNSUPPORTED', 422);
  }
  if (type === 'playlist' || type === 'multi_video' || Array.isArray(data.entries)) {
    throw new AppError('UNSUPPORTED', 422);
  }
  if (data.has_drm === true || data.has_drm === 'maybe') {
    throw new AppError('UNSUPPORTED', 422);
  }
  if (data.is_live === true || data.live_status === 'is_upcoming' || data.live_status === 'is_live') {
    throw new AppError('UNAVAILABLE', 422);
  }
  if (['private', 'premium_only', 'subscriber_only', 'needs_auth'].includes(availability)) {
    throw new AppError(availability === 'private' ? 'PRIVATE_CONTENT' : 'AUTH_REQUIRED', 403);
  }
}

export async function createProbe(rawUrl: unknown): Promise<IProbeRecord> {
  const extractedUrl = extractVideoUrlFromText(rawUrl);
  if (!extractedUrl) throw new AppError('INVALID_URL', 400);
  const parsedUrl = await assertPublicMediaUrl(extractedUrl);
  const requestedPlatform = detectPlatform(parsedUrl.href);
  if (requestedPlatform.id === 'other') {
    throw new AppError('UNSUPPORTED', 422);
  }

  const engine = await requireEngine();
  if (requestedPlatform.id === 'kuaishou') {
    const result = await probeKuaishou(parsedUrl);
    const optionId = randomUUID();
    const format = result.media.formats[0];
    if (!format) throw new AppError('UNSUPPORTED', 422);
    const options = new Map<string, IStoredOption>([
      [optionId, { rawFormatId: 'best', hasAudio: true }],
    ]);
    const record: IProbeRecord = {
      id: randomUUID(),
      url: parsedUrl.href,
      sourceId: result.media.id,
      media: { ...result.media, formats: [{ ...format, id: optionId }] },
      options,
      downloadSource: {
        mode: 'direct',
        url: result.downloadUrl,
        referer: result.canonicalUrl,
        userAgent: KUAISHOU_USER_AGENT,
      },
      expiresAt: Date.now() + PROBE_TTL_MS,
    };
    probes.set(record.id, record);
    return record;
  }

  let rawOutput: string;
  try {
    const result = await runEngineCapture(
      engine,
      [
        '--ignore-config',
        '--no-plugin-dirs',
        '--no-update',
        '--no-playlist',
        '--default-search',
        'error',
        '--skip-download',
        '--dump-single-json',
        '--no-warnings',
        '--socket-timeout',
        '15',
        '--retries',
        '2',
        '--fragment-retries',
        '2',
        '--extractor-retries',
        '2',
        '--',
        parsedUrl.href,
      ],
      45_000,
    );
    rawOutput = result.stdout;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw classifyEngineError(error instanceof Error ? error.message : String(error));
  }

  let rawData: unknown;
  try {
    rawData = JSON.parse(rawOutput);
  } catch {
    throw new AppError('UNAVAILABLE', 422);
  }

  assertAllowedSource(rawData, parsedUrl.href);
  const normalized = normalizeMediaInfo(rawData, parsedUrl.href);
  const options = new Map<string, IStoredOption>();
  const formats = normalized.formats.map((format) => {
    const optionId = randomUUID();
    options.set(optionId, { rawFormatId: format.id, hasAudio: format.hasAudio });
    return { ...format, id: optionId };
  });

  const record: IProbeRecord = {
    id: randomUUID(),
    url: parsedUrl.href,
    sourceId: normalized.id,
    media: { ...normalized, formats },
    options,
    downloadSource: {
      mode: 'extractor',
      url: parsedUrl.href,
      referer: null,
      userAgent: null,
    },
    expiresAt: Date.now() + PROBE_TTL_MS,
  };
  probes.set(record.id, record);
  return record;
}

export function getProbe(probeId: unknown): IProbeRecord {
  if (typeof probeId !== 'string') throw new AppError('JOB_NOT_FOUND', 404);
  const probe = probes.get(probeId);
  if (!probe || probe.expiresAt <= Date.now()) {
    if (probe) probes.delete(probeId);
    throw new AppError('JOB_NOT_FOUND', 410);
  }
  return probe;
}

export function getProbeOption(probe: IProbeRecord, optionId: unknown): IStoredOption {
  if (typeof optionId !== 'string') throw new AppError('JOB_NOT_FOUND', 404);
  const option = probe.options.get(optionId);
  if (!option) throw new AppError('JOB_NOT_FOUND', 404);
  return option;
}

export function removeExpiredProbes(): void {
  const now = Date.now();
  for (const [id, probe] of probes) {
    if (probe.expiresAt <= now) probes.delete(id);
  }
}
