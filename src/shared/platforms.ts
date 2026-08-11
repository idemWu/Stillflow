import type { IPlatform, PlatformId } from './types.js';

export interface IPlatformDefinition {
  id: Exclude<PlatformId, 'other'>;
  label: string;
  glyph: string;
  hosts: readonly string[];
}

export const PLATFORM_DEFINITIONS: readonly IPlatformDefinition[] = [
  { id: 'youtube', label: 'YouTube', glyph: 'YT', hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'] },
  { id: 'x', label: 'X / Twitter', glyph: 'X', hosts: ['x.com', 'twitter.com'] },
  { id: 'tiktok', label: 'TikTok', glyph: 'TT', hosts: ['tiktok.com'] },
  { id: 'instagram', label: 'Instagram', glyph: 'IG', hosts: ['instagram.com'] },
  { id: 'vimeo', label: 'Vimeo', glyph: 'VM', hosts: ['vimeo.com'] },
  { id: 'bilibili', label: 'Bilibili', glyph: 'B', hosts: ['bilibili.com', 'b23.tv'] },
  { id: 'douyin', label: '抖音', glyph: 'DY', hosts: ['douyin.com', 'iesdouyin.com'] },
  { id: 'kuaishou', label: '快手', glyph: 'KS', hosts: ['kuaishou.com', 'kuaishou.cn'] },
];

export function matchesPlatformHost(hostname: string, candidate: string): boolean {
  return hostname === candidate || hostname.endsWith(`.${candidate}`);
}

export function detectPlatform(rawUrl: string): IPlatform {
  let hostname = '';
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { id: 'other', label: '其他平台', host: '' };
    }
    hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return { id: 'other', label: '其他平台', host: '' };
  }

  const definition = PLATFORM_DEFINITIONS.find(({ hosts }) =>
    hosts.some((candidate) => matchesPlatformHost(hostname, candidate)),
  );
  return definition
    ? { id: definition.id, label: definition.label, host: hostname }
    : { id: 'other', label: '其他平台', host: hostname };
}
