'use strict';

const express = require('express');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { Readable } = require('node:stream');

const app = express();

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const MAX_IMAGES = 10;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_SECONDS_PER_IMAGE = 3;
const MAX_SECONDS_PER_IMAGE = 20;
const TARGET_WIDTH = 1080;
const TARGET_HEIGHT = 1920;
const TARGET_FPS = 30;
const FFMPEG_STDERR_PREVIEW_CHARS = 4000;
const DRAWTEXT_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

const ALLOWED_AUDIO_TYPES = new Set(['audio/mpeg', 'application/octet-stream']);
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

let isRendering = false;

app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

app.get('/', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

app.post('/render', async (req, res) => {
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

    const imagePaths = [];
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

    const outputBuffer = await fs.readFile(outputPath);
    console.log(`[render] sucesso output_bytes=${outputBuffer.length}`);

    return res
      .status(200)
      .set({
        'Content-Type': 'video/mp4',
        'Content-Length': String(outputBuffer.length),
        'Content-Disposition': 'inline; filename="output.mp4"'
      })
      .send(outputBuffer);
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    const stderrPreview = truncate(String(error?.stderr || error?.message || ''), FFMPEG_STDERR_PREVIEW_CHARS);
    console.error('[render] erro', error);
    return res.status(500).json({
      error: 'Falha no FFmpeg durante a renderizacao.',
      ...(stderrPreview ? { stderr_preview: stderrPreview } : {})
    });
  } finally {
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch((cleanupError) => {
        console.error('[render] erro ao limpar temporarios', cleanupError);
      });
    }
    isRendering = false;
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'JSON invalido no corpo da requisicao.' });
  }

  console.error('[http] erro inesperado', error);
  return res.status(500).json({ error: 'Erro interno inesperado.' });
});

app.listen(PORT, () => {
  console.log(`FFmpeg Worker URL mode rodando na porta ${PORT}`);
});

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `Campo "${fieldName}" e obrigatorio.`);
  }
  return value.trim();
}

function requireImageUrlArray(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, 'Campo "image_urls" e obrigatorio (1 a 10 URLs).');
  }
  if (value.length > MAX_IMAGES) {
    throw new HttpError(400, `Campo "image_urls" aceita no maximo ${MAX_IMAGES} URLs.`);
  }

  const cleaned = value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new HttpError(400, `Campo "image_urls[${index}]" deve ser uma URL valida.`);
    }
    return item.trim();
  });

  return cleaned;
}

function parseSecondsPerImage(value) {
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

function validateUrl(urlValue, fieldName) {
  try {
    const parsed = new URL(urlValue);
    if (!(parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      throw new Error('URL precisa de protocolo http/https.');
    }
  } catch (_error) {
    throw new HttpError(400, `Campo "${fieldName}" deve conter URL valida http/https.`);
  }
}

async function downloadToFile({ url, destinationPath, allowedContentTypes, timeoutMs, maxBytes, fileLabel }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === 'AbortError') {
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
    throw new HttpError(400, `Content-Type invalido para ${fileLabel}: "${contentTypeHeader || 'desconhecido'}".`);
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
    transform(chunk, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        callback(new HttpError(400, `${fileLabel} excede limite de 50MB.`));
      } else {
        callback(null, chunk);
      }
    }
  });

  try {
    const bodyStream = Readable.fromWeb(response.body);
    await pipeline(bodyStream, limiter, createWriteStream(destinationPath));
    if (totalBytes === 0) {
      throw new HttpError(400, `${fileLabel} vazio.`);
    }
    return { bytes: totalBytes, contentType: contentTypeHeader };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error?.name === 'AbortError') {
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

function contentTypeToImageExtension(contentType) {
  return contentType === 'image/png' ? '.png' : '.jpg';
}

async function getMediaDuration(filePath) {
  const args = [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath
  ];
  const { stdout } = await runProcess(FFPROBE_BIN, args);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Nao foi possivel determinar duracao do audio.');
  }
  return duration;
}

async function createConcatFile({ concatPath, imagePaths, secondsPerImage, audioDurationSec }) {
  const totalImageTime = imagePaths.length * secondsPerImage;
  const extraTimeForLastImage = Math.max(0, audioDurationSec - totalImageTime) + 0.10;
  const lastDuration = secondsPerImage + extraTimeForLastImage;

  const lines = [];
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

async function runFfmpegWithOptionalText({ concatPath, audioPath, outputPath, script }) {
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
  } catch (error) {
    const stderr = String(error?.stderr || '');
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

async function runRenderFfmpeg({ concatPath, audioPath, outputPath, script }) {
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

  await runProcess(FFMPEG_BIN, ffmpegArgs);
}

function buildVideoFilter(script) {
  const base = `[0:v]fps=${TARGET_FPS},scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase,crop=${TARGET_WIDTH}:${TARGET_HEIGHT},setsar=1`;
  if (!script) {
    return `${base},format=yuv420p[vout]`;
  }

  const escaped = escapeDrawtext(script);
  return `${base},drawtext=fontfile=${DRAWTEXT_FONT}:text='${escaped}':fontcolor=white:fontsize=56:line_spacing=8:borderw=3:bordercolor=black@0.75:box=1:boxcolor=black@0.45:boxborderw=18:x=(w-text_w)/2:y=h-280,format=yuv420p[vout]`;
}

function escapeDrawtext(text) {
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

function isDrawtextRelatedError(stderr) {
  return /drawtext|freetype|fontconfig|font file|cannot find a valid font/i.test(stderr);
}

function escapeConcatPath(value) {
  return value.replace(/'/g, "'\\''");
}

function sanitizeUrlForLog(urlValue) {
  try {
    const parsed = new URL(urlValue);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_error) {
    return '[url-invalida]';
  }
}

function truncate(value, maxChars) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(-maxChars)} [truncated]`;
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`${command} finalizou com codigo ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}
