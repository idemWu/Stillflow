import type { ICreateDownloadResponse, IProbeResponse } from '../shared/types.js';
import { findEquivalentMediaFormat } from '../shared/mediaSelection.js';
import { ApiClientError, createDownload, createProbe } from './api.js';

interface IDownloadRecoveryDependencies {
  createProbe: (url: string) => Promise<IProbeResponse>;
  createDownload: (probeId: string, optionId: string) => Promise<ICreateDownloadResponse>;
}

export interface IDownloadRecoveryResult {
  response: ICreateDownloadResponse;
  probe: IProbeResponse;
  optionId: string;
  refreshed: boolean;
}

const DEFAULT_DEPENDENCIES: IDownloadRecoveryDependencies = {
  createProbe,
  createDownload,
};

export async function createDownloadWithProbeRecovery(
  probe: IProbeResponse,
  optionId: string,
  dependencies: IDownloadRecoveryDependencies = DEFAULT_DEPENDENCIES,
): Promise<IDownloadRecoveryResult> {
  try {
    return {
      response: await dependencies.createDownload(probe.probeId, optionId),
      probe,
      optionId,
      refreshed: false,
    };
  } catch (error) {
    if (!(error instanceof ApiClientError) || error.code !== 'JOB_NOT_FOUND') throw error;

    const previousFormat = probe.media.formats.find((format) => format.id === optionId);
    const refreshedProbe = await dependencies.createProbe(probe.media.originalUrl);
    const refreshedFormat = findEquivalentMediaFormat(previousFormat, refreshedProbe.media.formats);
    if (!refreshedFormat) {
      throw new ApiClientError('刷新解析后没有找到可导出的清晰度。', 'UNAVAILABLE');
    }

    return {
      response: await dependencies.createDownload(refreshedProbe.probeId, refreshedFormat.id),
      probe: refreshedProbe,
      optionId: refreshedFormat.id,
      refreshed: true,
    };
  }
}
