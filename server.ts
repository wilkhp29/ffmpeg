const express = require('express') as typeof import('express');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const { createWriteStream, createReadStream } = require('node:fs') as typeof import('node:fs');
const { spawn } = require('node:child_process') as typeof import('node:child_process');
const { pipeline } = require('node:stream/promises') as typeof import('node:stream/promises');
const { Transform, Readable } = require('node:stream') as typeof import('node:stream');

import type { NextFunction, Request, Response } from 'express';

type RenderRequestBody = {
  audio_url?: unknown;
  image_urls?: unknown;
  script?: unknown;
  title?: unknown;
  seconds_per_image?: unknown;
};

type DownloadToFileOptions = {
  url: string;
  destinationPath: string;
  allowedContentTypes: Set<string>;
  timeoutMs: number;
  maxBytes: number;
  fileLabel: string;
};

type DownloadResult = {
  bytes: number;
  contentType: string;
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

const app = express();

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const MAX_IMAGES = 10;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_SECONDS_PER_IMAGE = 3;
const MAX_SECONDS_PER_IMAGE = 20;
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

const ALLOWED_AUDIO_TYPES = new Set(['audio/mpeg', 'application/octet-stream']);
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

let isRendering = false;

app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).type('text/plain').send('ok');
});

app.get('/', (_req: Request, res: Response) => {
  res.status(200).type('text/plain').send('ok');
});

app.post('/render', async (req: Request<unknown, unknown, RenderRequestBody>, res: Response) => {
  if (isRendering) {
    return res.status(429).json({ error: 'Worker ocupado. Tente novamente em instantes.' });
  }

  isRendering = true;
  let workDir = '';

  try {
    const {
      audio_url: audioUrlRaw,
      image_urls: imageUrlsRaw,
      script: scriptRaw,
      title: titleRaw,
      seconds_per_image: secondsPerImageRaw
    } = req.body || {};
    void titleRaw;

    const audioUrl = requireNonEmptyString(audioUrlRaw, 'audio_url');
    const imageUrls = requireImageUrlArray(imageUrlsRaw);
    const secondsPerImage = parseSecondsPerImage(secondsPerImageRaw);
    const script = typeof scriptRaw === 'string' ? scriptRaw.trim() : '';

    validateUrl(audioUrl, 'audio_url');
    for (let i = 0; i < imageUrls.length; i += 1) {
      validateUrl(imageUrls[i], `image_urls[${i}]`);
    }

    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-worker-url-'));
    const audioPath = path.join(workDir, 'audio.mp3');

    const audioDownload = await downloadToFile({
      url: audioUrl,
      destinationPath: audioPath,
      allowedContentTypes: ALLOWED_AUDIO_TYPES,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      maxBytes: MAX_DOWNLOAD_BYTES,
      fileLabel: 'audio'
    });

    const imagePaths: string[] = [];
    for (let i = 0; i < imageUrls.length; i += 1) {
      const url = imageUrls[i];
      const tempPath = path.join(workDir, `img_${String(i).padStart(3, '0')}.tmp`);
      const imageDownload = await downloadToFile({
        url,
        destinationPath: tempPath,
        allowedContentTypes: ALLOWED_IMAGE_TYPES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        maxBytes: MAX_DOWNLOAD_BYTES,
        fileLabel: `image #${i + 1}`
      });

      const ext = contentTypeToImageExtension(imageDownload.contentType);
      const finalPath = path.join(workDir, `img_${String(i).padStart(3, '0')}${ext}`);
      await fs.rename(tempPath, finalPath);
      imagePaths.push(finalPath);
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
      `[render] inicio images=${imagePaths.length} audio_url=${sanitizeUrlForLog(
        audioUrl
      )} audio_bytes=${audioDownload.bytes} duracao_estimada=${estimatedDurationSec.toFixed(2)}s`
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

    const outputStat = await fs.stat(outputPath);
    console.log(`[render] sucesso output_bytes=${outputStat.size}`);

    res.status(200).set({
      'Content-Type': 'video/mp4',
      'Content-Length': String(outputStat.size),
      'Content-Disposition': 'inline; filename="output.mp4"'
    });

    await streamFileToResponse(outputPath, res);
    return;
  } catch (error: unknown) {
    if (res.headersSent) {
      res.end();
      return;
    }

    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    if (isProcessTimeoutError(error)) {
      return res.status(504).json({
        error: `Timeout no FFmpeg apos ${FFMPEG_TIMEOUT_MS}ms. Tente audio menor ou menos imagens.`
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

    console.error('[render] erro', error);
    return res.status(500).json({
      error: 'Falha no FFmpeg durante a renderizacao.',
      ...(stderrPreview ? { stderr_preview: stderrPreview } : {})
    });
  } finally {
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch((cleanupError: unknown) => {
        console.error('[render] erro ao limpar temporarios', cleanupError);
      });
    }
    isRendering = false;
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (
    error instanceof SyntaxError &&
    (error as SyntaxError & { status?: number }).status === 400 &&
    'body' in (error as object)
  ) {
    return res.status(400).json({ error: 'JSON invalido no corpo da requisicao.' });
  }

  console.error('[http] erro inesperado', error);
  return res.status(500).json({ error: 'Erro interno inesperado.' });
});

app.listen(PORT, () => {
  console.log(`FFmpeg Worker URL mode rodando na porta ${PORT}`);
});

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

  const cleaned = value.map((item: unknown, index: number) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new HttpError(400, `Campo "image_urls[${index}]" deve ser uma URL valida.`);
    }
    return item.trim();
  });

  return cleaned;
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

function validateUrl(urlValue: string, fieldName: string): void {
  try {
    const parsed = new URL(urlValue);
    if (!(parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      throw new Error('URL precisa de protocolo http/https.');
    }
  } catch {
    throw new HttpError(400, `Campo "${fieldName}" deve conter URL valida http/https.`);
  }
}

async function downloadToFile(options: DownloadToFileOptions): Promise<DownloadResult> {
  const { url, destinationPath, allowedContentTypes, timeoutMs, maxBytes, fileLabel } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
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
    throw new HttpError(502, `Falha ao baixar ${fileLabel}: HTTP ${response.status}.`);
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
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
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
    return { bytes: totalBytes, contentType: contentTypeHeader };
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
      console.warn('[render] drawtext indisponivel, renderizando sem texto');
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
    '-movflags',
    '+faststart',
    '-shortest',
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

async function streamFileToResponse(filePath: string, res: Response): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const fileStream = createReadStream(filePath);
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    fileStream.on('error', fail);
    res.on('finish', finish);
    res.on('close', () => {
      if (!res.writableEnded) {
        fileStream.destroy();
        fail(new Error('Conexao encerrada durante envio do video.'));
      }
    });

    fileStream.pipe(res);
  });
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
