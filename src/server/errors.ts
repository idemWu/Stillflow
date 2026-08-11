import type { ApiErrorCode, IApiError } from '../shared/types.js';

const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  INVALID_URL: '这不是有效的公开视频链接，请检查后重试。',
  RIGHTS_REQUIRED: '请先确认你拥有下载与处理权限。',
  PRIVATE_ADDRESS: '出于安全原因，不能解析本机或内网地址。',
  ENGINE_MISSING: '解析引擎尚未安装，请先运行 yarn run setup:engine。',
  FFMPEG_MISSING: '该清晰度需要 FFmpeg 合并音视频，请先安装本地解析引擎。',
  AUTH_REQUIRED: '该内容需要登录，净流仅处理无需登录的公开内容。',
  PRIVATE_CONTENT: '该内容不是公开内容，无法解析。',
  GEO_RESTRICTED: '该内容在当前地区不可用。',
  RATE_LIMITED: '来源平台暂时拒绝访问，请稍后重试。',
  UNSUPPORTED: '暂不支持该平台或链接类型。',
  UNAVAILABLE: '视频不存在、已删除，或当前无法访问。',
  FILE_TOO_LARGE: '文件超过当前服务允许的大小。',
  NETWORK_ERROR: '连接来源平台失败，请检查网络后重试。',
  PROBE_TIMEOUT: '解析等待时间过长，请稍后重试。',
  DOWNLOAD_FAILED: '文件准备没有完成，请重新尝试。',
  JOB_NOT_FOUND: '这个导出任务不存在或已经过期。',
  JOB_NOT_READY: '文件仍在准备中，请稍后再试。',
  INTERNAL_ERROR: '服务暂时出现问题，请稍后重试。',
};

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly detail?: string;

  constructor(code: ApiErrorCode, status = 400, detail?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function classifyEngineError(rawOutput: string): AppError {
  const output = rawOutput.toLowerCase();

  if (
    output.includes('sign in to confirm') ||
    output.includes('login required') ||
    output.includes('cookies from browser') ||
    output.includes('authentication required')
  ) {
    return new AppError('AUTH_REQUIRED', 403);
  }

  if (output.includes('private video') || output.includes('only available to registered users')) {
    return new AppError('PRIVATE_CONTENT', 403);
  }

  if (output.includes('not available in your country') || output.includes('geo-restricted')) {
    return new AppError('GEO_RESTRICTED', 451);
  }

  if (output.includes('too many requests') || output.includes('http error 429')) {
    return new AppError('RATE_LIMITED', 429);
  }

  if (output.includes('unsupported url') || output.includes('no suitable extractor')) {
    return new AppError('UNSUPPORTED', 422);
  }

  if (
    output.includes('video unavailable') ||
    output.includes('content is not available') ||
    output.includes('has been removed') ||
    output.includes('http error 404')
  ) {
    return new AppError('UNAVAILABLE', 404);
  }

  if (output.includes('ffmpeg') && (output.includes('not found') || output.includes('not installed'))) {
    return new AppError('FFMPEG_MISSING', 503);
  }

  if (output.includes('larger than max-filesize') || output.includes('file is larger')) {
    return new AppError('FILE_TOO_LARGE', 413);
  }

  if (
    output.includes('unable to download webpage') ||
    output.includes('network is unreachable') ||
    output.includes('temporary failure in name resolution') ||
    output.includes('timed out')
  ) {
    return new AppError('NETWORK_ERROR', 502);
  }

  return new AppError('DOWNLOAD_FAILED', 502, rawOutput.slice(-1_000));
}

export function toApiError(error: unknown, requestId: string): IApiError {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, requestId };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: ERROR_MESSAGES.INTERNAL_ERROR,
    requestId,
  };
}
