import type { IPlatform, PlatformId } from '../shared/types.js';

interface IPlatformRule {
  id: PlatformId;
  label: string;
  hosts: string[];
}

const PLATFORM_RULES: IPlatformRule[] = [
  { id: 'youtube', label: 'YouTube', hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'] },
  { id: 'x', label: 'X / Twitter', hosts: ['x.com', 'twitter.com'] },
  { id: 'tiktok', label: 'TikTok', hosts: ['tiktok.com'] },
  { id: 'instagram', label: 'Instagram', hosts: ['instagram.com'] },
  { id: 'vimeo', label: 'Vimeo', hosts: ['vimeo.com'] },
  { id: 'bilibili', label: 'Bilibili', hosts: ['bilibili.com', 'b23.tv'] },
  { id: 'douyin', label: '抖音', hosts: ['douyin.com', 'iesdouyin.com'] },
  { id: 'kuaishou', label: '快手', hosts: ['kuaishou.com', 'gifshow.com'] },
];

function matchesHost(hostname: string, candidate: string): boolean {
  return hostname === candidate || hostname.endsWith(`.${candidate}`);
}

export function detectPlatform(rawUrl: string): IPlatform {
  let hostname = '';
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return { id: 'other', label: '其他平台', host: '' };
  }

  const rule = PLATFORM_RULES.find(({ hosts }) => hosts.some((host) => matchesHost(hostname, host)));
  return rule
    ? { id: rule.id, label: rule.label, host: hostname }
    : { id: 'other', label: '其他平台', host: hostname };
}
