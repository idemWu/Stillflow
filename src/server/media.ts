import type { IMediaFormat, IMediaInfo } from '../shared/types.js';
import { AppError } from './errors.js';
import { detectPlatform } from './platform.js';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getThumbnail(data: UnknownRecord): string | null {
  const direct = asString(data.thumbnail);
  if (direct) return direct;

  const thumbnails = Array.isArray(data.thumbnails) ? data.thumbnails : [];
  const candidate = thumbnails
    .map(asRecord)
    .filter((item): item is UnknownRecord => item !== null)
    .sort((left, right) => (asNumber(right.width) ?? 0) - (asNumber(left.width) ?? 0))
    .find((item) => asString(item.url));

  return candidate ? asString(candidate.url) : null;
}

function formatScore(item: UnknownRecord): number {
  const extension = asString(item.ext)?.toLowerCase();
  const codec = asString(item.vcodec)?.toLowerCase() ?? '';
  const audioCodec = asString(item.acodec)?.toLowerCase();
  const bitrate = asNumber(item.tbr) ?? 0;
  return (
    (extension === 'mp4' ? 4_000_000 : 0) +
    (/^(avc|h264)/.test(codec) ? 2_000_000 : 0) +
    (audioCodec && audioCodec !== 'none' ? 1_000_000 : 0) +
    bitrate
  );
}

export function normalizeFormats(rawFormats: unknown): IMediaFormat[] {
  if (!Array.isArray(rawFormats)) return [];

  const allowedProtocols = new Set([
    'http',
    'https',
    'm3u8',
    'm3u8_native',
    'http_dash_segments',
    'dash',
  ]);

  const candidates = rawFormats
    .map(asRecord)
    .filter((item): item is UnknownRecord => {
      if (!item) return false;
      const videoCodec = asString(item.vcodec)?.toLowerCase();
      const protocol = asString(item.protocol)?.toLowerCase();
      const note = asString(item.format_note)?.toLowerCase() ?? '';
      const formatId = asString(item.format_id);
      const hasDrm = item.has_drm === true || item.has_drm === 'maybe';
      return (
        Boolean(formatId && /^[a-zA-Z0-9_.-]{1,80}$/.test(formatId)) &&
        videoCodec !== null &&
        videoCodec !== 'none' &&
        Boolean(protocol && allowedProtocols.has(protocol)) &&
        !hasDrm &&
        !note.includes('storyboard') &&
        (asNumber(item.height) ?? 0) >= 144
      );
    })
    .sort((left, right) => {
      const heightDifference = (asNumber(right.height) ?? 0) - (asNumber(left.height) ?? 0);
      return heightDifference || formatScore(right) - formatScore(left);
    });

  const bestByHeight = new Map<number, UnknownRecord>();
  for (const candidate of candidates) {
    const height = asNumber(candidate.height);
    if (height && !bestByHeight.has(height)) bestByHeight.set(height, candidate);
  }

  return [...bestByHeight.values()].slice(0, 8).map((item) => {
    const height = asNumber(item.height);
    const width = asNumber(item.width);
    const fps = asNumber(item.fps);
    const dynamicRange = asString(item.dynamic_range)?.toUpperCase() ?? '';
    const hdr = dynamicRange.includes('HDR') || dynamicRange.includes('HLG') || dynamicRange.includes('DV');
    const labelParts = [`${height ?? '?'}p`];
    if (fps && fps > 30) labelParts.push(`${Math.round(fps)} FPS`);
    if (hdr) labelParts.push('HDR');

    return {
      id: asString(item.format_id) ?? '',
      label: labelParts.join(' · '),
      resolution: width && height ? `${width} × ${height}` : `${height ?? '?'}p`,
      width,
      height,
      fps,
      extension: asString(item.ext)?.toUpperCase() ?? 'VIDEO',
      codec: asString(item.vcodec),
      hasAudio: Boolean(asString(item.acodec) && asString(item.acodec) !== 'none'),
      hdr,
      estimatedBytes: asNumber(item.filesize) ?? asNumber(item.filesize_approx),
    };
  });
}

export function normalizeMediaInfo(rawData: unknown, requestedUrl: string): IMediaInfo {
  const data = asRecord(rawData);
  if (!data) throw new AppError('UNAVAILABLE', 422);

  const id = asString(data.id);
  const title = asString(data.title);
  if (!id || !title) throw new AppError('UNAVAILABLE', 422);

  const formats = normalizeFormats(data.formats);
  if (formats.length === 0) throw new AppError('UNSUPPORTED', 422);

  return {
    id,
    title,
    description: asString(data.description),
    author: asString(data.uploader) ?? asString(data.channel) ?? asString(data.creator),
    durationSeconds: asNumber(data.duration),
    thumbnailUrl: getThumbnail(data),
    publishedAt: asString(data.upload_date) ?? asString(data.release_date),
    viewCount: asNumber(data.view_count),
    platform: detectPlatform(requestedUrl),
    formats,
    originalUrl: requestedUrl,
  };
}
