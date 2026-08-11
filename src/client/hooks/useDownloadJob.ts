import { useCallback, useEffect, useState } from 'react';
import type { IDownloadJob } from '../../shared/types';
import { cancelDownload, getDownloadJob } from '../api';

interface IUseDownloadJobResult {
  job: IDownloadJob | null;
  begin: (job: IDownloadJob) => void;
  cancel: () => Promise<void>;
  clear: () => void;
}

const TERMINAL_STATES = new Set(['ready', 'failed', 'cancelled']);

export function useDownloadJob(): IUseDownloadJobResult {
  const [job, setJob] = useState<IDownloadJob | null>(null);

  useEffect(() => {
    if (!job || TERMINAL_STATES.has(job.status)) return undefined;
    let active = true;
    let requestInFlight = false;
    const poll = async (): Promise<void> => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const latest = await getDownloadJob(job.id);
        if (active) setJob(latest);
      } catch {
        // The interval keeps polling after a transient connection failure.
      } finally {
        requestInFlight = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 850);
    void poll();

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status]);

  const begin = useCallback((nextJob: IDownloadJob): void => {
    setJob(nextJob);
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    if (!job || TERMINAL_STATES.has(job.status)) return;
    await cancelDownload(job.id);
    setJob((current) => current ? { ...current, status: 'cancelled' } : null);
  }, [job]);

  const clear = useCallback((): void => setJob(null), []);

  return { job, begin, cancel, clear };
}
