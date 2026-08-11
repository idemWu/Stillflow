import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type {
  ICreateDownloadRequest,
  ICreateDownloadResponse,
  IHealthResponse,
  IProbeRequest,
  IProbeResponse,
} from '../shared/types.js';
import {
  cancelJob,
  createDownloadJob,
  getDownloadFile,
  getDownloadJob,
  getDownloadLimits,
  removeExpiredJobs,
  removeOrphanedJobDirectories,
  shutdownDownloads,
} from './downloadManager.js';
import { AppError, toApiError } from './errors.js';
import { resolveEngine } from './engine.js';
import {
  createProbe,
  getProbe,
  getProbeOption,
  removeExpiredProbes,
} from './probeManager.js';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CLIENT_DIST = path.join(PROJECT_ROOT, 'dist', 'client');
const PORT = Math.max(1_024, Number(process.env.PORT) || 8_787);
const HOST = '127.0.0.1';
const CLIENT_HEADER = 'x-jingliu-client';
const allowedOrigins = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);

const app = express();
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(express.json({ limit: '8kb', strict: true }));

app.use('/api', (request: Request, response: Response, next: NextFunction) => {
  response.locals.requestId = randomUUID();
  response.setHeader('X-Request-Id', response.locals.requestId);
  response.setHeader('Cache-Control', 'no-store');

  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    next();
    return;
  }

  const origin = request.get('origin');
  const clientHeader = request.get(CLIENT_HEADER);
  if ((origin && !allowedOrigins.has(origin)) || clientHeader !== 'web-v1') {
    next(new AppError('INVALID_URL', 403));
    return;
  }

  next();
});

app.get('/api/v1/health', async (_request, response, next) => {
  try {
    const engine = await resolveEngine();
    const ffmpegAvailable = Boolean(
      engine?.ffmpegPath && (await access(engine.ffmpegPath).then(() => true).catch(() => false)),
    );
    const payload: IHealthResponse = {
      status: engine ? 'ready' : 'degraded',
      engine: {
        available: Boolean(engine),
        version: engine?.version ?? null,
        ffmpegAvailable,
      },
      limits: getDownloadLimits(),
    };
    response.json(payload);
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/probes', async (request: Request, response: Response, next: NextFunction) => {
  try {
    const body = request.body as Partial<IProbeRequest>;
    if (body.rightsConfirmed !== true) throw new AppError('RIGHTS_REQUIRED', 403);
    const probe = await createProbe(body.url);
    const payload: IProbeResponse = {
      probeId: probe.id,
      expiresAt: new Date(probe.expiresAt).toISOString(),
      media: probe.media,
    };
    response.status(201).json(payload);
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/downloads', (request: Request, response: Response, next: NextFunction) => {
  try {
    const body = request.body as Partial<ICreateDownloadRequest>;
    if (body.rightsConfirmed !== true) throw new AppError('RIGHTS_REQUIRED', 403);
    const probe = getProbe(body.probeId);
    const option = getProbeOption(probe, body.optionId);
    const payload: ICreateDownloadResponse = {
      job: createDownloadJob(probe, option.rawFormatId, option.hasAudio),
    };
    response.status(202).json(payload);
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/downloads/:id', (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json({ job: getDownloadJob(request.params.id) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/downloads/:id/file', (request: Request, response: Response, next: NextFunction) => {
  try {
    const { job, filePath } = getDownloadFile(request.params.id);
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.download(filePath, job.fileName ?? 'video.mp4', (error) => {
      if (error && !response.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/v1/downloads/:id', async (request: Request, response: Response, next: NextFunction) => {
  try {
    await cancelJob(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
app.use((request: Request, response: Response, next: NextFunction) => {
  if (request.method !== 'GET' || request.path.startsWith('/api/')) {
    next();
    return;
  }
  response.sendFile(path.join(CLIENT_DIST, 'index.html'), (error) => {
    if (error && !response.headersSent) next(error);
  });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const requestId = typeof response.locals.requestId === 'string'
    ? response.locals.requestId
    : randomUUID();
  const apiError = toApiError(error, requestId);
  const status = error instanceof AppError ? error.status : 500;
  if (status >= 500) console.error(`[${requestId}] ${apiError.code}`);
  response.status(status).json({ error: apiError });
});

const janitor = setInterval(() => {
  removeExpiredProbes();
  void removeExpiredJobs();
}, 5 * 60 * 1_000);
janitor.unref();
await removeOrphanedJobDirectories();
await removeExpiredJobs();

const server = app.listen(PORT, HOST, () => {
  console.log(`净流服务已启动：http://${HOST}:${PORT}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(janitor);
  server.close();
  await shutdownDownloads();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
