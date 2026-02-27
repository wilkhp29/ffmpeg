const express = require('express') as typeof import('express');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const { createWriteStream } = require('node:fs') as typeof import('node:fs');
const { spawn } = require('node:child_process') as typeof import('node:child_process');
const { pipeline } = require('node:stream/promises') as typeof import('node:stream/promises');
const { Readable, Transform } = require('node:stream') as typeof import('node:stream');
const crypto = require('node:crypto') as typeof import('node:crypto');

import type { NextFunction, Request, Response } from 'express';
import type { PlaywrightJobError } from './playwright/errors';

const { runPlaywrightJob } = require('./playwright/runner') as typeof import('./playwright/runner');
const {
  PlaywrightHttpError,
  PlaywrightJobError: PlaywrightJobErrorCtor
} = require('./playwright/errors') as typeof import('./playwright/errors');
const {
  ensurePlaywrightDirectories,
  resolveArtifactPath,
  saveRawStorageState
} = require('./playwright/storage') as typeof import('./playwright/storage');
const {
  parseAllowDomains,
  parseRunRequestBody,
  validateSessionName
} = require('./playwright/validators') as typeof import('./playwright/validators');

type RenderRequestBody = {
  audio_url?: unknown;
  audio_urls?: unknown;
  audio_headers?: unknown;
  image_urls?: unknown;
  script?: unknown;
  title?: unknown;
  seconds_per_image?: unknown;
  request_id?: unknown;
};

type DownloadToFileOptions = {
  url: string;
  destinationPath: string;
  allowedContentTypes: Set<string>;
  requestHeaders?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  fileLabel: string;
};

type DownloadResult = {
  bytes: number;
  contentType: string;
};

type DownloadAudioPartsOptions = {
  audioUrls: string[];
  workDir: string;
  audioHeaders: Record<string, string>;
};

type DownloadAudioPartsResult = {
  partPaths: string[];
  totalBytes: number;
};

type CreateConcatFileOptions = {
  concatPath: string;
  imagePaths: string[];
  secondsPerImage: number;
  audioDurationSec: number;
};

type RenderFfmpegOptions = {
  concatPath: string;
  audioPath: string;
  outputPath: string;
  script: string;
};

type RunProcessOptions = {
  timeoutMs?: number;
};

type RunProcessResult = {
  stdout: string;
  stderr: string;
};

type ProcessError = Error & {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
};

type ProcessingJob = {
  status: 'processing';
  createdAt: number;
  startedAt: number;
};

type CompletedJob = {
  status: 'completed';
  createdAt: number;
  startedAt: number;
  finishedAt: number;
  output: string;
};

type JobRecord = ProcessingJob | CompletedJob;

const app = express();

const PORT = parsePositiveInteger(process.env.PORT, 3000);
const MAX_IMAGES = 10;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = parsePositiveInteger(process.env.DOWNLOAD_TIMEOUT_MS, 30_000);
const DEFAULT_SECONDS_PER_IMAGE = 3;
const MAX_SECONDS_PER_IMAGE = 20;
const MAX_AUDIO_URLS = 30;
const MAX_AUDIO_DURATION_SEC = parsePositiveInteger(process.env.MAX_AUDIO_DURATION_SEC, 60);
const TARGET_WIDTH = 1080;
const TARGET_HEIGHT = 1920;
const TARGET_FPS = 30;
const FFMPEG_PRESET = process.env.FFMPEG_PRESET || 'veryfast';
const FFMPEG_TIMEOUT_MS = parsePositiveInteger(process.env.FFMPEG_TIMEOUT_MS, 180_000);
const FFMPEG_STDERR_PREVIEW_CHARS = 4000;
const DRAWTEXT_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';
const MAX_CONCURRENT_JOBS = parsePositiveInteger(process.env.MAX_CONCURRENT_JOBS, 1);
const RETRY_AFTER_SEC = parsePositiveInteger(process.env.RETRY_AFTER_SEC, 5);
const JOB_CACHE_TTL_MS = parsePositiveInteger(process.env.JOB_CACHE_TTL_MS, 60 * 60 * 1000);
const OUTPUT_TTL_MS = parsePositiveInteger(process.env.OUTPUT_TTL_MS, 6 * 60 * 60 * 1000);
const OUTPUT_CLEANUP_INTERVAL_MS = parsePositiveInteger(
  process.env.OUTPUT_CLEANUP_INTERVAL_MS,
  10 * 60 * 1000
);
const OUTPUT_ROOT = process.env.OUTPUT_ROOT || path.join(os.tmpdir(), 'ffmpeg-worker-outputs');
const OUTPUT_BASE_URL = String(process.env.OUTPUT_BASE_URL || '').trim().replace(/\/+$/, '');
const OUTPUT_ROUTE_PREFIX = '/outputs';
const GOOGLE_TTS_BASE_URL =
  'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=pt-BR&q=';
const GOOGLE_TTS_MAX_CHARS = parsePositiveInteger(process.env.GOOGLE_TTS_MAX_CHARS, 180);
const PLAYWRIGHT_TOKEN = String(process.env.PLAYWRIGHT_TOKEN || '').trim();
const PLAYWRIGHT_ALLOW_DOMAINS = parseAllowDomains(process.env.ALLOW_DOMAINS);
const PLAYWRIGHT_MAX_ACTIONS = parsePositiveInteger(process.env.MAX_ACTIONS, 50);
const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = parsePositiveInteger(process.env.DEFAULT_TIMEOUT_MS, 60_000);
const PLAYWRIGHT_STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), 'storageStates');
const PLAYWRIGHT_OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(process.cwd(), 'outputs');
const PLAYWRIGHT_TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'playwright-runner-tmp');
const PLAYWRIGHT_ARTIFACTS_ROUTE_PREFIX = '/playwright/artifacts';
const PLAYWRIGHT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const PLAYWRIGHT_UPLOAD_DOWNLOAD_TIMEOUT_MS = 30_000;

const ALLOWED_AUDIO_TYPES = new Set(['audio/mpeg', 'application/octet-stream']);
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

const jobCache = new Map<string, JobRecord>();
let activeJobs = 0;
let outputRootReady: Promise<void> | undefined;

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

if (!PLAYWRIGHT_TOKEN) {
  throw new Error('PLAYWRIGHT_TOKEN e obrigatorio para habilitar endpoints /playwright/*.');
}

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    services: {
      ffmpeg: 'ok',
      playwright: 'ok'
    },
    playwright: {
      allow_domains: PLAYWRIGHT_ALLOW_DOMAINS,
      max_actions: PLAYWRIGHT_MAX_ACTIONS,
      default_timeout_ms: PLAYWRIGHT_DEFAULT_TIMEOUT_MS
    }
  });
});

app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.get(`${OUTPUT_ROUTE_PREFIX}/:filename`, async (req: Request, res: Response) => {
  const filename = String(req.params.filename || '').trim();
  if (!/^[a-zA-Z0-9._-]+\.mp4$/i.test(filename)) {
    return res.status(400).json({ error: 'Nome de arquivo invalido.' });
  }

  await ensureOutputRoot();

  const outputRootResolved = path.resolve(OUTPUT_ROOT);
  const filePath = path.resolve(OUTPUT_ROOT, filename);
  if (!filePath.startsWith(`${outputRootResolved}${path.sep}`)) {
    return res.status(400).json({ error: 'Caminho de arquivo invalido.' });
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'Arquivo nao encontrado.' });
    }
  } catch {
    return res.status(404).json({ error: 'Arquivo nao encontrado.' });
  }

  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.sendFile(filePath, (error: NodeJS.ErrnoException | null) => {
    if (!error || res.headersSent) {
      return;
    }

    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'Arquivo nao encontrado.' });
      return;
    }

    res.status(500).json({ error: 'Falha ao enviar arquivo.' });
  });
});

app.post('/playwright/run', requirePlaywrightAuth, async (req: Request, res: Response) => {
  try {
    const parsedRequest = parseRunRequestBody(req.body, {
      maxActions: PLAYWRIGHT_MAX_ACTIONS,
      defaultTimeoutMs: PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
      allowDomains: PLAYWRIGHT_ALLOW_DOMAINS
    });

    console.log(
      `[playwright] start actions=${parsedRequest.actions.length} session=${parsedRequest.session || '-'}`
    );

    const result = await runPlaywrightJob(parsedRequest, {
      allowDomains: PLAYWRIGHT_ALLOW_DOMAINS,
      storageDir: PLAYWRIGHT_STORAGE_DIR,
      outputDir: PLAYWRIGHT_OUTPUT_DIR,
      tmpDir: PLAYWRIGHT_TMP_DIR,
      artifactsRoutePrefix: PLAYWRIGHT_ARTIFACTS_ROUTE_PREFIX,
      defaultTimeoutMs: PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
      maxUploadBytes: PLAYWRIGHT_UPLOAD_MAX_BYTES,
      maxUploadDownloadTimeoutMs: PLAYWRIGHT_UPLOAD_DOWNLOAD_TIMEOUT_MS
    });

    console.log(`[playwright] success job=${result.jobId} took_ms=${result.tookMs}`);
    return res.status(200).json(result);
  } catch (error: unknown) {
    if (error instanceof PlaywrightHttpError) {
      return res.status(error.statusCode).json({
        ok: false,
        error: error.message,
        ...(error.details ? { details: error.details } : {})
      });
    }

    if (error instanceof PlaywrightJobErrorCtor) {
      const jobError = error as PlaywrightJobError;
      return res.status(jobError.statusCode).json({
        ok: false,
        jobId: jobError.jobId,
        tookMs: jobError.tookMs,
        error: jobError.message,
        ...(jobError.details ? { details: jobError.details } : {}),
        logs: jobError.logs
      });
    }

    console.error('[playwright] unexpected error', error);
    return res.status(500).json({
      ok: false,
      error: 'Falha inesperada ao executar Playwright job.'
    });
  }
});

app.post('/playwright/save-state', requirePlaywrightAuth, async (req: Request, res: Response) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new PlaywrightHttpError(400, 'Body invalido.');
    }

    const payload = req.body as Record<string, unknown>;
    const session = validateSessionName(payload.session, 'session');

    if (payload.storageState !== undefined) {
      if (!payload.storageState || typeof payload.storageState !== 'object') {
        throw new PlaywrightHttpError(400, 'Campo "storageState" deve ser objeto JSON.');
      }

      const filePath = await saveRawStorageState(
        PLAYWRIGHT_STORAGE_DIR,
        session,
        payload.storageState
      );

      return res.status(200).json({
        ok: true,
        session,
        file: path.basename(filePath)
      });
    }

    const actions: unknown[] = Array.isArray(payload.actions)
      ? payload.actions
      : Array.isArray(payload.commands)
        ? payload.commands
        : [];

    const parsedRequest = parseRunRequestBody(
      {
        session,
        timeoutMs: payload.timeoutMs,
        actions: [...actions, { action: 'saveStorage', session }]
      },
      {
        maxActions: PLAYWRIGHT_MAX_ACTIONS,
        defaultTimeoutMs: PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
        allowDomains: PLAYWRIGHT_ALLOW_DOMAINS
      }
    );

    const result = await runPlaywrightJob(parsedRequest, {
      allowDomains: PLAYWRIGHT_ALLOW_DOMAINS,
      storageDir: PLAYWRIGHT_STORAGE_DIR,
      outputDir: PLAYWRIGHT_OUTPUT_DIR,
      tmpDir: PLAYWRIGHT_TMP_DIR,
      artifactsRoutePrefix: PLAYWRIGHT_ARTIFACTS_ROUTE_PREFIX,
      defaultTimeoutMs: PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
      maxUploadBytes: PLAYWRIGHT_UPLOAD_MAX_BYTES,
      maxUploadDownloadTimeoutMs: PLAYWRIGHT_UPLOAD_DOWNLOAD_TIMEOUT_MS
    });

    return res.status(200).json(result);
  } catch (error: unknown) {
    if (error instanceof PlaywrightHttpError) {
      return res.status(error.statusCode).json({
        ok: false,
        error: error.message,
        ...(error.details ? { details: error.details } : {})
      });
    }

    if (error instanceof PlaywrightJobErrorCtor) {
      const jobError = error as PlaywrightJobError;
      return res.status(jobError.statusCode).json({
        ok: false,
        jobId: jobError.jobId,
        tookMs: jobError.tookMs,
        error: jobError.message,
        ...(jobError.details ? { details: jobError.details } : {}),
        logs: jobError.logs
      });
    }

    console.error('[playwright] save-state unexpected error', error);
    return res.status(500).json({
      ok: false,
      error: 'Falha inesperada ao salvar storageState.'
    });
  }
});

app.get(
  '/playwright/artifacts/:jobId/:filename',
  requirePlaywrightAuth,
  async (req: Request, res: Response) => {
    const jobId = String(req.params.jobId || '').trim();
    const filename = String(req.params.filename || '').trim();

    let artifactPath = '';
    try {
      artifactPath = resolveArtifactPath(PLAYWRIGHT_OUTPUT_DIR, jobId, filename);
    } catch (error: unknown) {
      if (error instanceof PlaywrightHttpError) {
        return res.status(error.statusCode).json({ ok: false, error: error.message });
      }

      return res.status(400).json({ ok: false, error: 'Caminho de artefato invalido.' });
    }

    try {
      const stat = await fs.stat(artifactPath);
      if (!stat.isFile()) {
        return res.status(404).json({ ok: false, error: 'Artefato nao encontrado.' });
      }
    } catch {
      return res.status(404).json({ ok: false, error: 'Artefato nao encontrado.' });
    }

    const contentType = resolveArtifactContentType(filename);
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(artifactPath, (error: NodeJS.ErrnoException | null) => {
      if (!error || res.headersSent) {
        return;
      }

      if (error.code === 'ENOENT') {
        res.status(404).json({ ok: false, error: 'Artefato nao encontrado.' });
        return;
      }

      res.status(500).json({ ok: false, error: 'Falha ao enviar artefato.' });
    });
  }
);

app.post('/render', async (req: Request<unknown, unknown, RenderRequestBody>, res: Response) => {
  pruneJobCache();

  const idempotencyKey = resolveIdempotencyKey(req);
  const existingJob = jobCache.get(idempotencyKey);

  if (existingJob?.status === 'completed') {
    return res.status(200).json({
      success: true,
      output: existingJob.output,
      request_id: idempotencyKey,
      cached: true
    });
  }

  if (existingJob?.status === 'processing') {
    return res.status(202).json({
      success: false,
      status: 'processing',
      request_id: idempotencyKey,
      retryable: true,
      retry_after_sec: RETRY_AFTER_SEC
    });
  }

  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    // Busy is transient on free instances, so report as processing
    // to let clients retry without treating this as a hard failure.
    return res.status(202).json({
      success: false,
      status: 'processing',
      request_id: idempotencyKey,
      retryable: true,
      retry_after_sec: RETRY_AFTER_SEC
    });
  }

  const startedAt = Date.now();
  jobCache.set(idempotencyKey, {
    status: 'processing',
    createdAt: startedAt,
    startedAt
  });
  activeJobs += 1;

  let workDir = '';
  let keepCachedResult = false;

  try {
    const {
      audio_url: audioUrlRaw,
      audio_urls: audioUrlsRaw,
      audio_headers: audioHeadersRaw,
      image_urls: imageUrlsRaw,
      script: scriptRaw,
      title: titleRaw,
      seconds_per_image: secondsPerImageRaw
    } = req.body || {};
    void titleRaw;

    const audioUrls = parseAudioUrlList(audioUrlRaw, audioUrlsRaw);
    const audioHeaders = parseOptionalHeaderRecord(audioHeadersRaw, 'audio_headers');
    const imageUrls = requireImageUrlArray(imageUrlsRaw);
    const secondsPerImage = parseSecondsPerImage(secondsPerImageRaw);
    const script = typeof scriptRaw === 'string' ? scriptRaw.trim() : '';

    for (let i = 0; i < audioUrls.length; i += 1) {
      validateUrl(audioUrls[i], `audio_urls[${i}]`);
    }

    for (let i = 0; i < imageUrls.length; i += 1) {
      validateUrl(imageUrls[i], `image_urls[${i}]`);
    }

    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-worker-job-'));
    await ensureOutputRoot();

    const audioPath = path.join(workDir, 'audio.mp3');
    let effectiveAudioUrls = [...audioUrls];
    let audioSource: 'request' | 'google_fallback' = 'request';

    let downloadedAudio: DownloadAudioPartsResult;
    try {
      downloadedAudio = await downloadAudioParts({
        audioUrls: effectiveAudioUrls,
        workDir,
        audioHeaders
      });
    } catch (error: unknown) {
      const fallbackAudioUrls = buildGoogleTtsChunkUrls(script);
      if (!isAuthDownloadError(error) || fallbackAudioUrls.length === 0) {
        throw error;
      }

      console.warn(
        `[render] audio auth failed for request_id=${idempotencyKey}, retrying with google tts fallback`
      );

      effectiveAudioUrls = fallbackAudioUrls;
      audioSource = 'google_fallback';
      downloadedAudio = await downloadAudioParts({
        audioUrls: effectiveAudioUrls,
        workDir,
        audioHeaders: {}
      });
    }

    const { partPaths: audioPartPaths, totalBytes: totalAudioBytes } = downloadedAudio;

    if (audioPartPaths.length === 1) {
      await fs.rename(audioPartPaths[0], audioPath);
    } else {
      await concatAudioParts(audioPartPaths, audioPath);
    }

    const imagePaths: string[] = [];
    for (let i = 0; i < imageUrls.length; i += 1) {
      const imageTempPath = path.join(workDir, `img_${String(i).padStart(3, '0')}.tmp`);
      const imageDownload = await downloadToFile({
        url: imageUrls[i],
        destinationPath: imageTempPath,
        allowedContentTypes: ALLOWED_IMAGE_TYPES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        maxBytes: MAX_DOWNLOAD_BYTES,
        fileLabel: `image #${i + 1}`
      });

      const imageExt = contentTypeToImageExtension(imageDownload.contentType);
      const finalImagePath = path.join(workDir, `img_${String(i).padStart(3, '0')}${imageExt}`);
      await fs.rename(imageTempPath, finalImagePath);
      imagePaths.push(finalImagePath);
    }

    const audioDurationSec = await getMediaDuration(audioPath);
    if (audioDurationSec > MAX_AUDIO_DURATION_SEC) {
      throw new HttpError(
        400,
        `Audio excede limite de ${MAX_AUDIO_DURATION_SEC}s. Duracao detectada: ${audioDurationSec.toFixed(2)}s.`
      );
    }

    const estimatedDurationSec = Math.max(audioDurationSec, imagePaths.length * secondsPerImage);

    console.log(
      `[render] start request_id=${idempotencyKey} images=${imagePaths.length} audio_chunks=${
        effectiveAudioUrls.length
      } audio_source=${audioSource} audio_url=${sanitizeUrlForLog(
        effectiveAudioUrls[0]
      )} audio_bytes=${totalAudioBytes} est_duration=${estimatedDurationSec.toFixed(
        2
      )}s`
    );

    const concatPath = path.join(workDir, 'slides.txt');
    await createConcatFile({
      concatPath,
      imagePaths,
      secondsPerImage,
      audioDurationSec
    });

    const outputPath = path.join(workDir, 'output.mp4');
    await runFfmpegWithOptionalText({
      concatPath,
      audioPath,
      outputPath,
      script
    });

    const stableOutputName = `${createStableOutputId(idempotencyKey)}.mp4`;
    const persistedOutputPath = path.join(OUTPUT_ROOT, stableOutputName);
    await fs.copyFile(outputPath, persistedOutputPath);

    const output = resolveOutputValue(persistedOutputPath);

    jobCache.set(idempotencyKey, {
      status: 'completed',
      createdAt: startedAt,
      startedAt,
      finishedAt: Date.now(),
      output
    });

    keepCachedResult = true;

    console.log(`[render] success request_id=${idempotencyKey} output=${output}`);

    void cleanupOldOutputs();

    return res.status(200).json({
      success: true,
      output,
      request_id: idempotencyKey,
      cached: false
    });
  } catch (error: unknown) {
    if (res.headersSent) {
      res.end();
      return;
    }

    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({
        error: error.message,
        request_id: idempotencyKey,
        retryable: error.statusCode >= 500
      });
    }

    if (isProcessTimeoutError(error)) {
      return res.status(504).json({
        error: `Timeout no FFmpeg apos ${FFMPEG_TIMEOUT_MS}ms.`,
        request_id: idempotencyKey,
        retryable: true,
        retry_after_sec: RETRY_AFTER_SEC
      });
    }

    const stderrPreview = truncate(
      String(
        (error as { stderr?: string; message?: string } | null | undefined)?.stderr ||
          (error as { message?: string } | null | undefined)?.message ||
          ''
      ),
      FFMPEG_STDERR_PREVIEW_CHARS
    );

    console.error('[render] error', error);

    return res.status(500).json({
      error: 'Falha no FFmpeg durante a renderizacao.',
      request_id: idempotencyKey,
      retryable: true,
      ...(stderrPreview ? { stderr_preview: stderrPreview } : {})
    });
  } finally {
    if (!keepCachedResult) {
      jobCache.delete(idempotencyKey);
    }

    activeJobs = Math.max(0, activeJobs - 1);

    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch((cleanupError: unknown) => {
        console.error('[render] cleanup error', cleanupError);
      });
    }
  }
});

function requirePlaywrightAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = String(req.header('Authorization') || '').trim();

  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({ ok: false, error: 'Nao autorizado.' });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token || !isTokenEqual(token, PLAYWRIGHT_TOKEN)) {
    res.status(401).json({ ok: false, error: 'Nao autorizado.' });
    return;
  }

  next();
}

function isTokenEqual(value: string, expected: string): boolean {
  const a = Buffer.from(value, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function resolveArtifactContentType(filename: string): string | undefined {
  const ext = path.extname(filename).toLowerCase();

  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return undefined;
  }
}

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Rota nao encontrada.' });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (
    error instanceof SyntaxError &&
    (error as SyntaxError & { status?: number }).status === 400 &&
    'body' in (error as object)
  ) {
    return res.status(400).json({ error: 'JSON invalido no corpo da requisicao.' });
  }

  console.error('[http] unexpected error', error);
  return res.status(500).json({ error: 'Erro interno inesperado.' });
});

app.listen(PORT, () => {
  console.log(`FFmpeg Worker running on port ${PORT}`);
});

void ensureOutputRoot().catch((error: unknown) => {
  console.error('[startup] failed to prepare output directory', error);
});

void ensurePlaywrightDirectories({
  storageDir: PLAYWRIGHT_STORAGE_DIR,
  outputDir: PLAYWRIGHT_OUTPUT_DIR,
  tmpDir: PLAYWRIGHT_TMP_DIR
}).catch((error: unknown) => {
  console.error('[startup] failed to prepare playwright directories', error);
});

const cleanupInterval = setInterval(() => {
  void cleanupOldOutputs();
}, OUTPUT_CLEANUP_INTERVAL_MS);
cleanupInterval.unref();

class HttpError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `Campo "${fieldName}" e obrigatorio.`);
  }
  return value.trim();
}

function requireImageUrlArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, 'Campo "image_urls" e obrigatorio (1 a 10 URLs).');
  }

  if (value.length > MAX_IMAGES) {
    throw new HttpError(400, `Campo "image_urls" aceita no maximo ${MAX_IMAGES} URLs.`);
  }

  return value.map((item: unknown, index: number) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new HttpError(400, `Campo "image_urls[${index}]" deve ser uma URL valida.`);
    }
    return item.trim();
  });
}

function parseAudioUrlList(audioUrlValue: unknown, audioUrlsValue: unknown): string[] {
  const urls: string[] = [];

  const pushUrl = (raw: unknown, fieldName: string) => {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new HttpError(400, `Campo "${fieldName}" deve ser uma URL valida.`);
    }
    const cleaned = raw.trim();
    if (!urls.includes(cleaned)) {
      urls.push(cleaned);
    }
  };

  if (Array.isArray(audioUrlsValue)) {
    if (audioUrlsValue.length === 0) {
      throw new HttpError(400, 'Campo "audio_urls" nao pode ser vazio.');
    }
    if (audioUrlsValue.length > MAX_AUDIO_URLS) {
      throw new HttpError(400, `Campo "audio_urls" aceita no maximo ${MAX_AUDIO_URLS} URLs.`);
    }
    for (let i = 0; i < audioUrlsValue.length; i += 1) {
      pushUrl(audioUrlsValue[i], `audio_urls[${i}]`);
    }
  } else if (audioUrlsValue !== undefined && audioUrlsValue !== null) {
    throw new HttpError(400, 'Campo "audio_urls" deve ser um array de URLs.');
  }

  if (audioUrlValue !== undefined && audioUrlValue !== null && String(audioUrlValue).trim() !== '') {
    pushUrl(audioUrlValue, 'audio_url');
  }

  if (!urls.length) {
    throw new HttpError(400, 'Campo "audio_url" ou "audio_urls" e obrigatorio.');
  }

  return urls;
}

function parseSecondsPerImage(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_SECONDS_PER_IMAGE;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > MAX_SECONDS_PER_IMAGE) {
    throw new HttpError(
      400,
      `Campo "seconds_per_image" deve ser numero > 0 e <= ${MAX_SECONDS_PER_IMAGE}.`
    );
  }

  return numeric;
}

function parseOptionalHeaderRecord(value: unknown, fieldName: string): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `Campo "${fieldName}" deve ser um objeto de headers.`);
  }

  const parsedHeaders: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = String(rawKey).trim();
    const val = typeof rawValue === 'string' ? rawValue.trim() : '';

    if (!key || !val) {
      continue;
    }

    if (/\r|\n/.test(key) || /\r|\n/.test(val)) {
      throw new HttpError(400, `Campo "${fieldName}" contem header invalido.`);
    }

    parsedHeaders[key] = val;
  }

  return parsedHeaders;
}

function normalizeWhitespace(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function splitTextForGoogleTts(text: string, maxChars: number): string[] {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) {
    return [];
  }

  const chunks: string[] = [];
  const sentences = cleaned.match(/[^.!?]+[.!?]*/g) || [cleaned];
  let current = '';

  const pushCurrent = () => {
    const normalized = normalizeWhitespace(current);
    if (normalized) {
      chunks.push(normalized);
    }
    current = '';
  };

  for (const rawSentence of sentences) {
    const sentence = normalizeWhitespace(rawSentence);
    if (!sentence) {
      continue;
    }

    if (sentence.length > maxChars) {
      pushCurrent();

      const words = sentence.split(' ');
      let buffer = '';

      for (const rawWord of words) {
        const word = normalizeWhitespace(rawWord);
        if (!word) {
          continue;
        }

        const candidate = buffer ? `${buffer} ${word}` : word;
        if (candidate.length <= maxChars) {
          buffer = candidate;
          continue;
        }

        if (buffer) {
          chunks.push(buffer);
        }

        if (word.length > maxChars) {
          for (let i = 0; i < word.length; i += maxChars) {
            chunks.push(word.slice(i, i + maxChars));
          }
          buffer = '';
        } else {
          buffer = word;
        }
      }

      if (buffer) {
        chunks.push(buffer);
      }
      continue;
    }

    const merged = current ? `${current} ${sentence}` : sentence;
    if (merged.length <= maxChars) {
      current = merged;
    } else {
      pushCurrent();
      current = sentence;
    }
  }

  pushCurrent();
  return chunks.slice(0, MAX_AUDIO_URLS);
}

function buildGoogleTtsChunkUrls(script: string): string[] {
  const chunks = splitTextForGoogleTts(script, GOOGLE_TTS_MAX_CHARS);
  return chunks.map((chunk) => `${GOOGLE_TTS_BASE_URL}${encodeURIComponent(chunk)}`);
}

function isAuthDownloadError(error: unknown): boolean {
  return error instanceof HttpError && /HTTP (401|403)\b/.test(error.message);
}

function resolveIdempotencyKey(req: Request<unknown, unknown, RenderRequestBody>): string {
  const headerValue = req.header('Idempotency-Key');
  if (headerValue && headerValue.trim()) {
    return normalizeIdempotencyValue(headerValue);
  }

  const requestIdValue = req.body?.request_id;
  if (typeof requestIdValue === 'string' && requestIdValue.trim()) {
    return normalizeIdempotencyValue(requestIdValue);
  }

  const bodyFingerprint = stableStringify(req.body || {});
  return `auto_${crypto.createHash('sha256').update(bodyFingerprint).digest('hex').slice(0, 24)}`;
}

function normalizeIdempotencyValue(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 128);
  if (normalized) {
    return normalized;
  }
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function pruneJobCache(): void {
  const now = Date.now();

  for (const [key, record] of jobCache.entries()) {
    if (record.status === 'completed' && now - record.finishedAt > JOB_CACHE_TTL_MS) {
      jobCache.delete(key);
      continue;
    }

    if (record.status === 'processing' && now - record.startedAt > FFMPEG_TIMEOUT_MS * 2) {
      jobCache.delete(key);
    }
  }
}

function buildDefaultAudioFetchHeaders(audioUrl: string): Record<string, string> {
  let referer = 'https://api.streamelements.com/';

  try {
    const parsed = new URL(audioUrl);
    referer = `${parsed.protocol}//${parsed.host}/`;
  } catch {
    // fallback referer
  }

  return {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    Referer: referer
  };
}

async function downloadAudioParts(options: DownloadAudioPartsOptions): Promise<DownloadAudioPartsResult> {
  const { audioUrls, workDir, audioHeaders } = options;
  const partPaths: string[] = [];
  let totalBytes = 0;

  for (let i = 0; i < audioUrls.length; i += 1) {
    const audioPartPath = path.join(workDir, `audio_part_${String(i).padStart(3, '0')}.mp3`);
    const audioDownload = await downloadToFile({
      url: audioUrls[i],
      destinationPath: audioPartPath,
      allowedContentTypes: ALLOWED_AUDIO_TYPES,
      requestHeaders: {
        ...buildDefaultAudioFetchHeaders(audioUrls[i]),
        ...audioHeaders
      },
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      maxBytes: MAX_DOWNLOAD_BYTES,
      fileLabel: `audio${audioUrls.length > 1 ? ` #${i + 1}` : ''}`
    });

    partPaths.push(audioPartPath);
    totalBytes += audioDownload.bytes;
  }

  return {
    partPaths,
    totalBytes
  };
}

function validateUrl(urlValue: string, fieldName: string): void {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('URL precisa de protocolo http/https.');
    }
  } catch {
    throw new HttpError(400, `Campo "${fieldName}" deve conter URL valida http/https.`);
  }
}

async function downloadToFile(options: DownloadToFileOptions): Promise<DownloadResult> {
  const { url, destinationPath, allowedContentTypes, requestHeaders, timeoutMs, maxBytes, fileLabel } =
    options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: requestHeaders,
      signal: controller.signal
    });
  } catch (error: unknown) {
    clearTimeout(timeout);

    if ((error as { name?: string } | null | undefined)?.name === 'AbortError') {
      throw new HttpError(502, `Timeout ao baixar ${fileLabel} (${timeoutMs}ms).`);
    }

    throw new HttpError(502, `Falha de rede ao baixar ${fileLabel}.`);
  }

  if (!response.ok) {
    clearTimeout(timeout);

    const authHint =
      response.status === 401 || response.status === 403
        ? ' Verifique autenticacao/headers da URL de origem.'
        : '';

    throw new HttpError(502, `Falha ao baixar ${fileLabel}: HTTP ${response.status}.${authHint}`);
  }

  const contentTypeHeader = String(response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (!allowedContentTypes.has(contentTypeHeader)) {
    clearTimeout(timeout);
    throw new HttpError(
      400,
      `Content-Type invalido para ${fileLabel}: "${contentTypeHeader || 'desconhecido'}".`
    );
  }

  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredSize = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      clearTimeout(timeout);
      throw new HttpError(400, `${fileLabel} excede limite de 50MB.`);
    }
  }

  if (!response.body) {
    clearTimeout(timeout);
    throw new HttpError(502, `Resposta sem body ao baixar ${fileLabel}.`);
  }

  let totalBytes = 0;
  const limiter = new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null, data?: Buffer) => void
    ) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        callback(new HttpError(400, `${fileLabel} excede limite de 50MB.`));
      } else {
        callback(null, chunk);
      }
    }
  });

  try {
    const bodyStream = Readable.fromWeb(
      response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>
    );

    await pipeline(bodyStream, limiter, createWriteStream(destinationPath));

    if (totalBytes === 0) {
      throw new HttpError(400, `${fileLabel} vazio.`);
    }

    return {
      bytes: totalBytes,
      contentType: contentTypeHeader
    };
  } catch (error: unknown) {
    if (error instanceof HttpError) {
      throw error;
    }

    if ((error as { name?: string } | null | undefined)?.name === 'AbortError') {
      throw new HttpError(502, `Timeout ao baixar ${fileLabel} (${timeoutMs}ms).`);
    }

    throw new HttpError(502, `Falha ao salvar ${fileLabel}.`);
  } finally {
    clearTimeout(timeout);

    if (totalBytes === 0) {
      await fs.rm(destinationPath, { force: true }).catch(() => {});
    }
  }
}

function contentTypeToImageExtension(contentType: string): '.png' | '.jpg' {
  return contentType === 'image/png' ? '.png' : '.jpg';
}

async function getMediaDuration(filePath: string): Promise<number> {
  const args = [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath
  ];

  const { stdout } = await runProcess(FFPROBE_BIN, args, { timeoutMs: 20_000 });
  const duration = Number.parseFloat(stdout.trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new HttpError(400, 'Nao foi possivel determinar duracao do audio.');
  }

  return duration;
}

async function createConcatFile(options: CreateConcatFileOptions): Promise<void> {
  const { concatPath, imagePaths, secondsPerImage, audioDurationSec } = options;

  const totalImageTime = imagePaths.length * secondsPerImage;
  const extraTimeForLastImage = Math.max(0, audioDurationSec - totalImageTime) + 0.1;
  const lastDuration = secondsPerImage + extraTimeForLastImage;

  const lines: string[] = [];
  for (let i = 0; i < imagePaths.length; i += 1) {
    const filePath = imagePaths[i];
    const escapedFilePath = escapeConcatPath(filePath);
    const isLast = i === imagePaths.length - 1;

    lines.push(`file '${escapedFilePath}'`);
    lines.push(`duration ${(isLast ? lastDuration : secondsPerImage).toFixed(3)}`);

    if (isLast) {
      lines.push(`file '${escapedFilePath}'`);
    }
  }

  await fs.writeFile(concatPath, `${lines.join('\n')}\n`, 'utf8');
}

async function concatAudioParts(audioPartPaths: string[], outputPath: string): Promise<void> {
  if (audioPartPaths.length < 2) {
    throw new HttpError(500, 'Concatenacao de audio requer pelo menos 2 partes.');
  }

  const concatPath = path.join(path.dirname(outputPath), 'audio_concat.txt');
  const lines = audioPartPaths.map((filePath) => `file '${escapeConcatPath(filePath)}'`);
  await fs.writeFile(concatPath, `${lines.join('\n')}\n`, 'utf8');

  try {
    await runProcess(
      FFMPEG_BIN,
      ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', outputPath],
      { timeoutMs: 60_000 }
    );
    return;
  } catch (copyError: unknown) {
    console.warn('[render] audio concat copy failed, re-encoding', copyError);
  }

  await runProcess(
    FFMPEG_BIN,
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatPath,
      '-vn',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      outputPath
    ],
    { timeoutMs: 90_000 }
  );
}

async function runFfmpegWithOptionalText(options: RenderFfmpegOptions): Promise<void> {
  const { concatPath, audioPath, outputPath, script } = options;

  if (!script) {
    await runRenderFfmpeg({
      concatPath,
      audioPath,
      outputPath,
      script: ''
    });
    return;
  }

  try {
    await runRenderFfmpeg({
      concatPath,
      audioPath,
      outputPath,
      script
    });
  } catch (error: unknown) {
    const stderr = String((error as { stderr?: string } | null | undefined)?.stderr || '');

    if (isDrawtextRelatedError(stderr)) {
      console.warn('[render] drawtext unavailable, retrying without text');
      await runRenderFfmpeg({
        concatPath,
        audioPath,
        outputPath,
        script: ''
      });
      return;
    }

    throw error;
  }
}

async function runRenderFfmpeg(options: RenderFfmpegOptions): Promise<void> {
  const { concatPath, audioPath, outputPath, script } = options;

  const ffmpegArgs = [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatPath,
    '-i',
    audioPath,
    '-filter_complex',
    buildVideoFilter(script),
    '-map',
    '[vout]',
    '-map',
    '1:a:0',
    '-r',
    String(TARGET_FPS),
    '-c:v',
    'libx264',
    '-preset',
    FFMPEG_PRESET,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-af',
    'apad',
    '-movflags',
    '+faststart',
    outputPath
  ];

  await runProcess(FFMPEG_BIN, ffmpegArgs, { timeoutMs: FFMPEG_TIMEOUT_MS });
}

function buildVideoFilter(script: string): string {
  const base = `[0:v]fps=${TARGET_FPS},scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase,crop=${TARGET_WIDTH}:${TARGET_HEIGHT},setsar=1`;

  if (!script) {
    return `${base},format=yuv420p[vout]`;
  }

  const escaped = escapeDrawtext(script);
  return `${base},drawtext=fontfile=${DRAWTEXT_FONT}:text='${escaped}':fontcolor=white:fontsize=56:line_spacing=8:borderw=3:bordercolor=black@0.75:box=1:boxcolor=black@0.45:boxborderw=18:x=(w-text_w)/2:y=h-280,format=yuv420p[vout]`;
}

function escapeDrawtext(text: string): string {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n');
}

function isDrawtextRelatedError(stderr: string): boolean {
  return /drawtext|freetype|fontconfig|font file|cannot find a valid font/i.test(stderr);
}

function escapeConcatPath(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function sanitizeUrlForLog(urlValue: string): string {
  try {
    const parsed = new URL(urlValue);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[url-invalida]';
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(-maxChars)} [truncated]`;
}

function isProcessTimeoutError(error: unknown): error is ProcessError {
  return Boolean((error as ProcessError | null | undefined)?.timedOut);
}

function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {}
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutMs = options.timeoutMs || 0;
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : undefined;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: Error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      if (code === 0 && !timedOut) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(
        timedOut
          ? `${command} excedeu timeout de ${timeoutMs}ms`
          : `${command} finalizou com codigo ${code}`
      ) as ProcessError;

      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      error.timedOut = timedOut;
      reject(error);
    });
  });
}

function createStableOutputId(idempotencyKey: string): string {
  return crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24);
}

function resolveOutputValue(outputPath: string): string {
  const fileName = path.basename(outputPath);

  if (!OUTPUT_BASE_URL) {
    return `${OUTPUT_ROUTE_PREFIX}/${fileName}`;
  }
  return `${OUTPUT_BASE_URL}/${fileName}`;
}

function ensureOutputRoot(): Promise<void> {
  if (!outputRootReady) {
    outputRootReady = fs.mkdir(OUTPUT_ROOT, { recursive: true }).then(() => {});
  }
  return outputRootReady;
}

async function cleanupOldOutputs(): Promise<void> {
  await ensureOutputRoot();

  const now = Date.now();
  const files = await fs.readdir(OUTPUT_ROOT).catch(() => [] as string[]);

  for (const filename of files) {
    const fullPath = path.join(OUTPUT_ROOT, filename);
    const stat = await fs.stat(fullPath).catch(() => null);

    if (!stat || !stat.isFile()) {
      continue;
    }

    if (now - stat.mtimeMs > OUTPUT_TTL_MS) {
      await fs.rm(fullPath, { force: true }).catch(() => {});
    }
  }
}
