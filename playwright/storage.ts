import path from 'node:path';
import fs from 'node:fs/promises';

import { PlaywrightHttpError } from './errors';
import { validateSessionName } from './validators';

const SAFE_FILENAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function ensurePlaywrightDirectories(options: {
  storageDir: string;
  outputDir: string;
  tmpDir: string;
}): Promise<void> {
  await Promise.all([
    fs.mkdir(options.storageDir, { recursive: true }),
    fs.mkdir(options.outputDir, { recursive: true }),
    fs.mkdir(options.tmpDir, { recursive: true })
  ]);
}

export function getSessionStatePath(storageDir: string, session: string): string {
  const safeSession = validateSessionName(session, 'session');
  const fileName = `${safeSession}.json`;
  return resolveInsideRoot(storageDir, fileName, 'session file');
}

export async function hasSessionState(storageDir: string, session: string): Promise<boolean> {
  const sessionPath = getSessionStatePath(storageDir, session);

  try {
    const stat = await fs.stat(sessionPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function saveRawStorageState(
  storageDir: string,
  session: string,
  storageState: unknown
): Promise<string> {
  const sessionPath = getSessionStatePath(storageDir, session);
  await fs.writeFile(sessionPath, `${JSON.stringify(storageState, null, 2)}\n`, 'utf8');
  return sessionPath;
}

export async function ensureJobDirectories(outputDir: string, tmpDir: string, jobId: string): Promise<{
  jobOutputDir: string;
  jobTmpDir: string;
}> {
  validateJobId(jobId);

  const jobOutputDir = resolveInsideRoot(outputDir, jobId, 'job output directory');
  const jobTmpDir = resolveInsideRoot(tmpDir, jobId, 'job tmp directory');

  await Promise.all([
    fs.mkdir(jobOutputDir, { recursive: true }),
    fs.mkdir(jobTmpDir, { recursive: true })
  ]);

  return {
    jobOutputDir,
    jobTmpDir
  };
}

export function validateJobId(value: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new PlaywrightHttpError(400, 'jobId invalido.');
  }
}

export function sanitizeArtifactFilename(name: string): string {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    throw new PlaywrightHttpError(400, 'Nome de screenshot nao pode ser vazio.');
  }

  const collapsed = trimmed
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+/, '')
    .replace(/[-_.]+$/, '');

  const base = collapsed || 'screenshot';
  const withPng = base.toLowerCase().endsWith('.png') ? base : `${base}.png`;

  if (!SAFE_FILENAME_REGEX.test(withPng)) {
    throw new PlaywrightHttpError(400, 'Nome de screenshot invalido.');
  }

  return withPng;
}

export function resolveArtifactPath(outputDir: string, jobId: string, filename: string): string {
  validateJobId(jobId);
  validateArtifactFilename(filename);

  return resolveInsideRoot(outputDir, path.join(jobId, filename), 'artifact file');
}

export function validateArtifactFilename(filename: string): void {
  if (!SAFE_FILENAME_REGEX.test(filename)) {
    throw new PlaywrightHttpError(400, 'Nome de arquivo invalido.');
  }

  if (filename === '.' || filename === '..') {
    throw new PlaywrightHttpError(400, 'Nome de arquivo invalido.');
  }
}

export function resolveLocalUploadPath(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  return absolutePath;
}

function resolveInsideRoot(rootDir: string, targetPath: string, label: string): string {
  const rootResolved = path.resolve(rootDir);
  const resolved = path.resolve(rootDir, targetPath);

  if (resolved === rootResolved) {
    return resolved;
  }

  if (!resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new PlaywrightHttpError(400, `Tentativa de acesso invalido em ${label}.`);
  }

  return resolved;
}
