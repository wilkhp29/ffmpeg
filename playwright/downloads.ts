import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { PlaywrightHttpError } from './errors';
import { assertAllowedDomain } from './validators';

type DownloadImageOptions = {
  url: string;
  destinationDir: string;
  maxBytes: number;
  timeoutMs: number;
  allowDomains: string[];
};

export async function downloadImageFromUrl(options: DownloadImageOptions): Promise<{
  filePath: string;
  fileName: string;
  contentType: string;
  bytes: number;
}> {
  const { url, destinationDir, maxBytes, timeoutMs, allowDomains } = options;

  assertAllowedDomain(url, allowDomains, 'uploadFromUrl.url');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;

  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal
    });
  } catch (error: unknown) {
    clearTimeout(timeout);
    if ((error as { name?: string } | null | undefined)?.name === 'AbortError') {
      throw new PlaywrightHttpError(400, `Timeout ao baixar uploadFromUrl (${timeoutMs}ms).`);
    }
    throw new PlaywrightHttpError(400, 'Falha de rede ao baixar uploadFromUrl.');
  }

  if (!response.ok) {
    clearTimeout(timeout);
    throw new PlaywrightHttpError(
      400,
      `Falha ao baixar uploadFromUrl: HTTP ${response.status}.`
    );
  }

  const contentType = String(response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (!contentType.startsWith('image/')) {
    clearTimeout(timeout);
    throw new PlaywrightHttpError(
      400,
      `uploadFromUrl permite apenas image/*, recebido: ${contentType || 'desconhecido'}.`
    );
  }

  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredSize = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      clearTimeout(timeout);
      throw new PlaywrightHttpError(
        400,
        `Arquivo em uploadFromUrl excede limite de ${(maxBytes / (1024 * 1024)).toFixed(0)}MB.`
      );
    }
  }

  if (!response.body) {
    clearTimeout(timeout);
    throw new PlaywrightHttpError(400, 'uploadFromUrl retornou resposta sem body.');
  }

  const extension = mapImageExtension(contentType);
  const fileName = createSafeFileName(url, extension);
  const filePath = path.join(destinationDir, fileName);

  let totalBytes = 0;

  try {
    const webStream = response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>;
    const stream = Readable.fromWeb(webStream);

    await pipeline(
      stream,
      async function* limitAndCount(source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            throw new PlaywrightHttpError(
              400,
              `Arquivo em uploadFromUrl excede limite de ${(maxBytes / (1024 * 1024)).toFixed(0)}MB.`
            );
          }
          yield chunk;
        }
      },
      createWriteStream(filePath)
    );

    if (totalBytes === 0) {
      throw new PlaywrightHttpError(400, 'uploadFromUrl retornou arquivo vazio.');
    }

    return {
      filePath,
      fileName,
      contentType,
      bytes: totalBytes
    };
  } finally {
    clearTimeout(timeout);

    if (totalBytes === 0) {
      await fs.rm(filePath, { force: true }).catch(() => {});
    }
  }
}

function createSafeFileName(urlValue: string, extension: string): string {
  let pathname = '';
  try {
    pathname = new URL(urlValue).pathname;
  } catch {
    pathname = '';
  }

  const basename = path.basename(pathname || '') || 'upload';
  const stripped = basename.replace(/\.[^.]+$/, '');
  const normalized = stripped
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^[-_.]+/, '')
    .replace(/[-_.]+$/, '');

  const safeBase = normalized || 'upload';
  return `${safeBase}${extension}`;
}

function mapImageExtension(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/bmp':
      return '.bmp';
    default:
      return '.img';
  }
}
