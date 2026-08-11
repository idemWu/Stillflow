import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';

export interface IEngineInvocation {
  command: string;
  prefixArgs: string[];
  environment: NodeJS.ProcessEnv;
  version: string;
  ffmpegPath: string | null;
}

interface IEngineConfig {
  pythonCommand?: string;
  pythonPrefixArgs?: string[];
  modulePath?: string;
  ffmpegPath?: string;
}

interface IEngineCandidate {
  command: string;
  prefixArgs: string[];
  environment: NodeJS.ProcessEnv;
  ffmpegPath: string | null;
}

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const ENGINE_ROOT = path.join(PROJECT_ROOT, '.engine');
const ENGINE_CONFIG_PATH = path.join(ENGINE_ROOT, 'engine.json');

let cachedEngine: Promise<IEngineInvocation | null> | null = null;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readLocalConfig(): Promise<IEngineConfig | null> {
  try {
    return JSON.parse(await readFile(ENGINE_CONFIG_PATH, 'utf8')) as IEngineConfig;
  } catch {
    return null;
  }
}

async function findBundledFfmpeg(modulePath: string): Promise<string | null> {
  const binariesDirectory = path.join(modulePath, 'imageio_ffmpeg', 'binaries');
  try {
    const entries = await readdir(binariesDirectory, { withFileTypes: true });
    const executable = entries.find((entry) => {
      if (!entry.isFile()) return false;
      return process.platform === 'win32'
        ? /^ffmpeg.*\.exe$/i.test(entry.name)
        : /^ffmpeg/i.test(entry.name);
    });
    return executable ? path.join(binariesDirectory, executable.name) : null;
  } catch {
    return null;
  }
}

function inspectCandidate(candidate: IEngineCandidate): Promise<IEngineInvocation | null> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    const child = spawn(candidate.command, [...candidate.prefixArgs, '--version'], {
      env: candidate.environment,
      shell: false,
      windowsHide: true,
    });

    const finish = (result: IEngineInvocation | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, 6_000);

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const version = output.trim().split(/\r?\n/)[0];
      finish(
        code === 0 && version
          ? { ...candidate, version }
          : null,
      );
    });
  });
}

async function createCandidates(): Promise<IEngineCandidate[]> {
  const candidates: IEngineCandidate[] = [];
  const config = await readLocalConfig();
  const defaultModulePath = path.join(ENGINE_ROOT, 'python');
  const localModulePath = config?.modulePath && (await fileExists(config.modulePath))
    ? config.modulePath
    : defaultModulePath;
  const localFfmpeg = config?.ffmpegPath && (await fileExists(config.ffmpegPath))
    ? config.ffmpegPath
    : await findBundledFfmpeg(localModulePath);

  if (process.env.YT_DLP_PATH) {
    candidates.push({
      command: process.env.YT_DLP_PATH,
      prefixArgs: [],
      environment: process.env,
      ffmpegPath: process.env.FFMPEG_PATH ?? localFfmpeg,
    });
  }

  if (await fileExists(path.join(localModulePath, 'yt_dlp', '__main__.py'))) {
    candidates.push({
      command: config?.pythonCommand ?? (process.platform === 'win32' ? 'py' : 'python3'),
      prefixArgs: [...(config?.pythonPrefixArgs ?? []), '-m', 'yt_dlp'],
      environment: {
        ...process.env,
        PYTHONPATH: [localModulePath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
      ffmpegPath: process.env.FFMPEG_PATH ?? localFfmpeg,
    });
  }

  candidates.push(
    {
      command: 'yt-dlp',
      prefixArgs: [],
      environment: process.env,
      ffmpegPath: process.env.FFMPEG_PATH ?? null,
    },
    {
      command: process.platform === 'win32' ? 'py' : 'python3',
      prefixArgs: ['-m', 'yt_dlp'],
      environment: process.env,
      ffmpegPath: process.env.FFMPEG_PATH ?? null,
    },
  );

  return candidates;
}

export async function resolveEngine(forceRefresh = false): Promise<IEngineInvocation | null> {
  if (forceRefresh || !cachedEngine) {
    cachedEngine = (async () => {
      const candidates = await createCandidates();
      for (const candidate of candidates) {
        const result = await inspectCandidate(candidate);
        if (result) return result;
      }
      return null;
    })();
  }

  return cachedEngine;
}

export async function requireEngine(): Promise<IEngineInvocation> {
  const engine = await resolveEngine();
  if (!engine) throw new AppError('ENGINE_MISSING', 503);
  return engine;
}

export function spawnEngine(
  engine: IEngineInvocation,
  args: string[],
): ChildProcessWithoutNullStreams {
  return spawn(engine.command, [...engine.prefixArgs, ...args], {
    env: engine.environment,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
}

export function runEngineCapture(
  engine: IEngineInvocation,
  args: string[],
  timeoutMs: number,
  maxOutputBytes = 12 * 1024 * 1024,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnEngine(engine, args);
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(error);
    };

    const timeout = setTimeout(() => {
      finishWithError(new AppError('PROBE_TIMEOUT', 504));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        finishWithError(new AppError('UNAVAILABLE', 422));
        return;
      }
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
    });

    child.on('error', () => finishWithError(new AppError('ENGINE_MISSING', 503)));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `yt-dlp exited with code ${code ?? 'unknown'}`));
    });
  });
}
