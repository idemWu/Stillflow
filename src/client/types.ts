import type { PlatformId } from '../shared/types';

export interface IHistoryItem {
  id: string;
  title: string;
  author: string | null;
  thumbnailUrl: string | null;
  platformId: PlatformId;
  platformLabel: string;
  durationSeconds: number | null;
  createdAt: string;
}
