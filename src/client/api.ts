import type {
  ApiErrorCode,
  IApiErrorResponse,
  ICreateDownloadResponse,
  IDownloadJob,
  IHealthResponse,
  IProbeResponse,
} from '../shared/types.js';

export class ApiClientError extends Error {
  readonly code: ApiErrorCode;
  readonly requestId: string | null;

  constructor(message: string, code: ApiErrorCode = 'INTERNAL_ERROR', requestId: string | null = null) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.requestId = requestId;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('Content-Type', 'application/json');
  if (init?.method && init.method !== 'GET') headers.set('X-Jingliu-Client', 'web-v1');

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiClientError('无法连接净流服务，请确认服务已经启动。', 'NETWORK_ERROR');
  }

  if (!response.ok) {
    let payload: IApiErrorResponse | null = null;
    try {
      payload = (await response.json()) as IApiErrorResponse;
    } catch {
      // Keep the generic fallback below.
    }
    throw new ApiClientError(
      payload?.error.message ?? '请求没有完成，请稍后重试。',
      payload?.error.code,
      payload?.error.requestId ?? response.headers.get('X-Request-Id'),
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function getHealth(): Promise<IHealthResponse> {
  return request<IHealthResponse>('/api/v1/health');
}

export function createProbe(url: string): Promise<IProbeResponse> {
  return request<IProbeResponse>('/api/v1/probes', {
    method: 'POST',
    body: JSON.stringify({ url, rightsConfirmed: true }),
  });
}

export function createDownload(probeId: string, optionId: string): Promise<ICreateDownloadResponse> {
  return request<ICreateDownloadResponse>('/api/v1/downloads', {
    method: 'POST',
    body: JSON.stringify({ probeId, optionId, rightsConfirmed: true }),
  });
}

export async function getDownloadJob(id: string): Promise<IDownloadJob> {
  const payload = await request<{ job: IDownloadJob }>(`/api/v1/downloads/${encodeURIComponent(id)}`);
  return payload.job;
}

export function cancelDownload(id: string): Promise<void> {
  return request<void>(`/api/v1/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function getDownloadFileUrl(id: string): string {
  return `/api/v1/downloads/${encodeURIComponent(id)}/file`;
}
