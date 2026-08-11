export type PlatformId =
  | 'youtube'
  | 'x'
  | 'tiktok'
  | 'instagram'
  | 'vimeo'
  | 'bilibili'
  | 'douyin'
  | 'kuaishou'
  | 'other';

export interface IPlatform {
  id: PlatformId;
  label: string;
  host: string;
}

export interface IMediaFormat {
  id: string;
  label: string;
  resolution: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  extension: string;
  codec: string | null;
  hasAudio: boolean;
  hdr: boolean;
  estimatedBytes: number | null;
}

export interface IMediaInfo {
  id: string;
  title: string;
  description: string | null;
  author: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  viewCount: number | null;
  platform: IPlatform;
  formats: IMediaFormat[];
  originalUrl: string;
}

export type ApiErrorCode =
  | 'INVALID_URL'
  | 'RIGHTS_REQUIRED'
  | 'PRIVATE_ADDRESS'
  | 'ENGINE_MISSING'
  | 'FFMPEG_MISSING'
  | 'AUTH_REQUIRED'
  | 'PRIVATE_CONTENT'
  | 'GEO_RESTRICTED'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED'
  | 'UNAVAILABLE'
  | 'FILE_TOO_LARGE'
  | 'NETWORK_ERROR'
  | 'PROBE_TIMEOUT'
  | 'DOWNLOAD_FAILED'
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_READY'
  | 'INTERNAL_ERROR';

export interface IApiError {
  code: ApiErrorCode;
  message: string;
  requestId: string;
}

export interface IApiErrorResponse {
  error: IApiError;
}

export interface IProbeRequest {
  url: string;
  rightsConfirmed: true;
}

export interface IProbeResponse {
  probeId: string;
  expiresAt: string;
  media: IMediaInfo;
}

export interface ICreateDownloadRequest {
  probeId: string;
  optionId: string;
  rightsConfirmed: true;
}

export type DownloadJobStatus =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface IDownloadProgress {
  percent: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  speedBytesPerSecond: number | null;
  etaSeconds: number | null;
}

export interface IDownloadJob {
  id: string;
  status: DownloadJobStatus;
  progress: IDownloadProgress;
  fileName: string | null;
  fileBytes: number | null;
  createdAt: string;
  expiresAt: string;
  error: IApiError | null;
}

export interface ICreateDownloadResponse {
  job: IDownloadJob;
}

export interface IHealthResponse {
  status: 'ready' | 'degraded';
  engine: {
    available: boolean;
    version: string | null;
    ffmpegAvailable: boolean;
  };
  limits: {
    maxFileSizeMb: number;
    maxConcurrentDownloads: number;
  };
}
