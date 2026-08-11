import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IDownloadJob, IDownloadProgress } from '../shared/types.js';
import { AppError, classifyEngineError, toApiError } from './errors.js';
import { requireEngine, spawnEngine } from './engine.js';
import type { IProbeRecord } from './probeManager.js';

interface IJobInput {
  probe: IProbeRecord;
  rawFormatId: string;
  hasAudio: boolean;
}

interface IInternalJob {
  public: IDownloadJob;
  input: IJobInput;
  directory: string;
  filePath: string | null;
  childPid: number | null;
  timer: NodeJS.Timeout | null;
  quotaTimer: NodeJS.Timeout | null;
  quotaCheckInFlight: boolean;
}

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const JOBS_ROOT = path.join(PROJECT_ROOT, '.downloads');
const DOWNLOAD_TTL_MS = Math.max(5, Number(process.env.DOWNLOAD_TTL_MINUTES) || 30) * 60 * 1_000;
const MAX_FILE_SIZE_MB = Math.max(100, Number(process.env.MAX_FILE_SIZE_MB) || 2_048);
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_JOB_DISK_MB = Math.max(
  MAX_FILE_SIZE_MB,
  Number(process.env.MAX_JOB_DISK_MB) || MAX_FILE_SIZE_MB * 3,
);
const MAX_JOB_DISK_BYTES = MAX_JOB_DISK_MB * 1024 * 1024;
const MAX_CONCURRENT = Math.max(1, Math.min(4, Number(process.env.MAX_CONCURRENT_DOWNLOADS) || 2));
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000;

const jobs = new Map<string, IInternalJob>();
const queue: string[] = [];
let activeDownloads = 0;

function emptyProgress(): IDownloadProgress {
  return {
    percent: null,
    downloadedBytes: null,
    totalBytes: null,
    speedBytesPerSecond: null,
    etaSeconds: null,
  };
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function publicJob(job: IInternalJob): IDownloadJob {
  return structuredClone(job.public);
}

function toFiniteNumber(value: string | undefined): number | null {
  if (!value || value === 'NA' || value === 'None') return null;
  const parsed = Number(value.trim().replace('%', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeDownloadName(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\\/]+/g, '-')
    .trim();
  return cleaned.slice(0, 180) || 'video.mp4';
}

export function buildFormatExpression(rawFormatId: string, hasAudio: boolean): string {
  return hasAudio
    ? rawFormatId
    : `${rawFormatId}+ba[ext=m4a]/${rawFormatId}+ba/${rawFormatId}`;
}

function parseProgressLine(job: IInternalJob, line: string): void {
  const markerIndex = line.indexOf('__PROGRESS__');
  if (markerIndex >= 0) {
    const parts = line.slice(markerIndex + '__PROGRESS__'.length).trim().split('|');
    const downloadedBytes = toFiniteNumber(parts[1]);
    if (downloadedBytes && downloadedBytes > MAX_FILE_SIZE_BYTES) {
      void cancelJob(job.public.id, new AppError('FILE_TOO_LARGE', 413));
      return;
    }
    job.public.progress = {
      percent: toFiniteNumber(parts[0]),
      downloadedBytes,
      totalBytes: toFiniteNumber(parts[2]),
      speedBytesPerSecond: toFiniteNumber(parts[3]),
      etaSeconds: toFiniteNumber(parts[4]),
    };
    job.public.status = 'downloading';
  }

  if (line.includes('__POSTPROCESS__') || line.includes('[Merger]') || line.includes('[VideoRemuxer]')) {
    job.public.status = 'processing';
  }

  const fileMarkerIndex = line.indexOf('__FINAL_FILE__');
  if (fileMarkerIndex >= 0) {
    const candidate = line.slice(fileMarkerIndex + '__FINAL_FILE__'.length).trim();
    if (candidate && isPathInside(job.directory, candidate)) job.filePath = path.resolve(candidate);
  }
}

function consumeLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onText: (text: string) => void,
): void {
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    onText(text);
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    lines.forEach(onLine);
  });
  stream.on('end', () => {
    if (buffer) onLine(buffer);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessTree(pid: number | null): Promise<void> {
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      let settled = false;
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        killer.kill();
        finish();
      }, 10_000);
      killer.on('error', finish);
      killer.on('close', finish);
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 20 && isProcessGroupAlive(pid); attempt += 1) {
    await delay(100);
  }
  if (isProcessGroupAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The process group exited between the check and the signal.
    }
  }
}

async function getDirectorySize(directory: string): Promise<number> {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await getDirectorySize(entryPath);
    if (entry.isFile()) total += (await stat(entryPath)).size;
  }
  return total;
}

function startQuotaMonitor(job: IInternalJob): void {
  job.quotaTimer = setInterval(() => {
    if (job.quotaCheckInFlight || !['downloading', 'processing'].includes(job.public.status)) return;
    job.quotaCheckInFlight = true;
    void getDirectorySize(job.directory)
      .then((bytes) => {
        if (bytes > MAX_JOB_DISK_BYTES) {
          return cancelJob(job.public.id, new AppError('FILE_TOO_LARGE', 413));
        }
        return undefined;
      })
      .catch(() => undefined)
      .finally(() => {
        job.quotaCheckInFlight = false;
      });
  }, 1_000);
  job.quotaTimer.unref();
}

function clearJobTimers(job: IInternalJob): void {
  if (job.timer) clearTimeout(job.timer);
  if (job.quotaTimer) clearInterval(job.quotaTimer);
  job.timer = null;
  job.quotaTimer = null;
}

async function findOutputFile(job: IInternalJob): Promise<string | null> {
  if (job.filePath && isPathInside(job.directory, job.filePath)) {
    try {
      const info = await stat(job.filePath);
      if (info.isFile()) return job.filePath;
    } catch {
      // Fall back to scanning the isolated job directory.
    }
  }

  const entries = await readdir(job.directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.part') && !entry.name.endsWith('.ytdl'))
    .map((entry) => path.join(job.directory, entry.name));
  return files.length === 1 ? files[0] : null;
}

async function runJob(job: IInternalJob): Promise<void> {
  const requestId = randomUUID();
  try {
    await mkdir(job.directory, { recursive: true });
    const engine = await requireEngine();
    const formatExpression = buildFormatExpression(job.input.rawFormatId, job.input.hasAudio);
    const outputTemplate = path.join(job.directory, '%(title).120B [%(id)s].%(ext)s');
    const args = [
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-update',
      '--no-playlist',
      '--default-search',
      'error',
      '--no-cache-dir',
      '--newline',
      '--progress',
      '--progress-delta',
      '0.5',
      '--progress-template',
      'download:__PROGRESS__%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
      '--progress-template',
      'postprocess:__POSTPROCESS__%(progress.status)s',
      '--print',
      'after_move:__FINAL_FILE__%(filepath)s',
      '--socket-timeout',
      '15',
      '--retries',
      '2',
      '--fragment-retries',
      '2',
      '--extractor-retries',
      '2',
      '--max-filesize',
      `${MAX_FILE_SIZE_MB}M`,
      '--max-downloads',
      '1',
      '--windows-filenames',
      '--trim-filenames',
      '160',
      '--format',
      formatExpression,
      '--merge-output-format',
      'mp4',
      '--output',
      outputTemplate,
    ];
    if (engine.ffmpegPath) args.push('--ffmpeg-location', engine.ffmpegPath);
    args.push('--', job.input.probe.url);

    job.public.status = 'downloading';
    const child = spawnEngine(engine, args);
    job.childPid = child.pid ?? null;
    startQuotaMonitor(job);
    let stderr = '';
    consumeLines(child.stdout, (line) => parseProgressLine(job, line), () => undefined);
    consumeLines(
      child.stderr,
      (line) => parseProgressLine(job, line),
      (text) => {
        stderr = `${stderr}${text}`.slice(-100_000);
      },
    );

    await new Promise<void>((resolve, reject) => {
      job.timer = setTimeout(() => {
        void terminateProcessTree(job.childPid)
          .finally(() => reject(new AppError('DOWNLOAD_FAILED', 504)));
      }, DOWNLOAD_TIMEOUT_MS);
      child.on('error', () => reject(new AppError('ENGINE_MISSING', 503)));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(classifyEngineError(stderr));
      });
    });

    clearJobTimers(job);
    job.childPid = null;
    const filePath = await findOutputFile(job);
    if (!filePath) throw new AppError('DOWNLOAD_FAILED', 502);
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_FILE_SIZE_BYTES) throw new AppError('FILE_TOO_LARGE', 413);

    job.filePath = filePath;
    job.public.status = 'ready';
    job.public.progress = {
      percent: 100,
      downloadedBytes: info.size,
      totalBytes: info.size,
      speedBytesPerSecond: null,
      etaSeconds: 0,
    };
    job.public.fileName = sanitizeDownloadName(path.basename(filePath));
    job.public.fileBytes = info.size;
  } catch (error) {
    if (job.public.status !== 'cancelled' && job.public.status !== 'failed') {
      job.public.status = 'failed';
      job.public.error = toApiError(error, requestId);
    }
    clearJobTimers(job);
    job.childPid = null;
    await rm(job.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function schedule(): void {
  while (activeDownloads < MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift();
    const job = id ? jobs.get(id) : null;
    if (!job || job.public.status !== 'queued') continue;
    activeDownloads += 1;
    void runJob(job).finally(() => {
      activeDownloads -= 1;
      schedule();
    });
  }
}

export function createDownloadJob(probe: IProbeRecord, rawFormatId: string, hasAudio: boolean): IDownloadJob {
  const id = randomUUID();
  const now = Date.now();
  const job: IInternalJob = {
    public: {
      id,
      status: 'queued',
      progress: emptyProgress(),
      fileName: null,
      fileBytes: null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DOWNLOAD_TTL_MS).toISOString(),
      error: null,
    },
    input: { probe, rawFormatId, hasAudio },
    directory: path.join(JOBS_ROOT, id),
    filePath: null,
    childPid: null,
    timer: null,
    quotaTimer: null,
    quotaCheckInFlight: false,
  };
  jobs.set(id, job);
  queue.push(id);
  schedule();
  return publicJob(job);
}

export function getDownloadJob(id: unknown): IDownloadJob {
  if (typeof id !== 'string') throw new AppError('JOB_NOT_FOUND', 404);
  const job = jobs.get(id);
  if (!job) throw new AppError('JOB_NOT_FOUND', 404);
  return publicJob(job);
}

export function getDownloadFile(id: unknown): { job: IDownloadJob; filePath: string } {
  if (typeof id !== 'string') throw new AppError('JOB_NOT_FOUND', 404);
  const job = jobs.get(id);
  if (!job) throw new AppError('JOB_NOT_FOUND', 404);
  if (job.public.status !== 'ready' || !job.filePath || !isPathInside(job.directory, job.filePath)) {
    throw new AppError('JOB_NOT_READY', 409);
  }
  return { job: publicJob(job), filePath: job.filePath };
}

export async function cancelJob(id: unknown, reason?: AppError): Promise<void> {
  if (typeof id !== 'string') throw new AppError('JOB_NOT_FOUND', 404);
  const job = jobs.get(id);
  if (!job) return;

  const queuedIndex = queue.indexOf(id);
  if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
  job.public.status = reason ? 'failed' : 'cancelled';
  job.public.error = reason ? toApiError(reason, randomUUID()) : null;
  const childPid = job.childPid;
  clearJobTimers(job);
  await terminateProcessTree(childPid);
  job.childPid = null;
  await rm(job.directory, { recursive: true, force: true }).catch(() => undefined);
}

export async function removeExpiredJobs(): Promise<void> {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (Date.parse(job.public.expiresAt) > now) continue;
    await cancelJob(id);
    jobs.delete(id);
  }
}

export async function removeOrphanedJobDirectories(): Promise<void> {
  await mkdir(JOBS_ROOT, { recursive: true });
  const entries = await readdir(JOBS_ROOT, { withFileTypes: true });
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const entry of entries) {
    if (!entry.isDirectory() || !uuidPattern.test(entry.name) || jobs.has(entry.name)) continue;
    const orphanPath = path.join(JOBS_ROOT, entry.name);
    if (!isPathInside(JOBS_ROOT, orphanPath)) continue;
    await rm(orphanPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function shutdownDownloads(): Promise<void> {
  const ids = [...jobs.keys()];
  await Promise.all(ids.map((id) => cancelJob(id).catch(() => undefined)));
  jobs.clear();
  queue.length = 0;
}

export function getDownloadLimits(): { maxFileSizeMb: number; maxConcurrentDownloads: number } {
  return { maxFileSizeMb: MAX_FILE_SIZE_MB, maxConcurrentDownloads: MAX_CONCURRENT };
}
