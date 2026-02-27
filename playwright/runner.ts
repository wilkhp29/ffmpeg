import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { downloadImageFromUrl } from './downloads';
import {
  PlaywrightHttpError,
  PlaywrightJobError,
  getErrorMessage,
  isPlaywrightTimeoutError
} from './errors';
import {
  ensureJobDirectories,
  getSessionStatePath,
  hasSessionState,
  resolveLocalUploadPath,
  sanitizeArtifactFilename
} from './storage';
import type { PlaywrightAction, PlaywrightJobOutputs, PlaywrightRunRequest, PlaywrightRunResult, PlaywrightRunnerConfig } from './types';

const { chromium } = require('playwright') as {
  chromium: {
    launch: (options: {
      headless: boolean;
      args: string[];
      proxy?: { server: string; username?: string; password?: string };
    }) => Promise<BrowserLike>;
  };
};

type BrowserLike = {
  newContext: (options?: {
    storageState?: string;
    viewport?: { width: number; height: number };
    userAgent?: string;
    bypassCSP?: boolean;
    proxy?: { server: string; username?: string; password?: string };
  }) => Promise<BrowserContextLike>;
  close: () => Promise<void>;
};

type BrowserContextLike = {
  newPage: () => Promise<PageLike>;
  close: () => Promise<void>;
  storageState: (options: { path: string }) => Promise<void>;
};

type PageLike = {
  setDefaultTimeout: (timeout: number) => void;
  on: (event: string, listener: (...args: any[]) => void) => void;
  goto: (
    url: string,
    options: { waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout: number }
  ) => Promise<unknown>;
  click: (selector: string, options: { timeout: number; delay?: number }) => Promise<unknown>;
  fill: (selector: string, text: string, options: { timeout: number }) => Promise<unknown>;
  press: (
    selector: string,
    key: string,
    options: {
      timeout: number;
    }
  ) => Promise<unknown>;
  waitForSelector: (
    selector: string,
    options: { timeout: number; state: 'attached' | 'detached' | 'visible' | 'hidden' }
  ) => Promise<unknown>;
  waitForTimeout: (timeout: number) => Promise<void>;
  setInputFiles: (selector: string, files: string, options: { timeout: number }) => Promise<unknown>;
  screenshot: (options: {
    path: string;
    fullPage: boolean;
    timeout: number;
  }) => Promise<unknown>;
  textContent: (selector: string, options: { timeout: number }) => Promise<string | null>;
  getAttribute: (selector: string, attr: string, options: { timeout: number }) => Promise<string | null>;
  route: (
    url: string | RegExp | ((url: URL) => boolean),
    handler: (route: any) => void
  ) => Promise<void>;
  addInitScript: (script: string | Function | { path?: string; content?: string }) => Promise<void>;
  evaluate: (script: string | Function, arg?: any) => Promise<any>;
};

export async function runPlaywrightJob(
  request: PlaywrightRunRequest,
  config: PlaywrightRunnerConfig
): Promise<PlaywrightRunResult> {
  const startedAt = Date.now();
  const jobId = randomUUID();
  const logs: string[] = [];

  const outputs: PlaywrightJobOutputs = {
    artifacts: [],
    extracted: {},
    storage: []
  };

  let browser: BrowserLike | undefined;
  let context: BrowserContextLike | undefined;
  let tmpPathToCleanup = '';

  try {
    appendLog(
      logs,
      `[playwright] start job=${jobId} actions=${request.actions.length} session=${
        request.session || '-'
      } timeout_ms=${request.timeoutMs}`
    );

    const { jobOutputDir, jobTmpDir } = await ensureJobDirectories(
      config.outputDir,
      config.tmpDir,
      jobId
    );
    tmpPathToCleanup = jobTmpDir;

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ],
      proxy: request.proxy
    });

    const contextOptions: { storageState?: string } = {};

    if (request.session) {
      const sessionExists = await hasSessionState(config.storageDir, request.session);
      if (sessionExists) {
        contextOptions.storageState = getSessionStatePath(config.storageDir, request.session);
        appendLog(logs, `[playwright] loaded storageState session=${request.session}`);
      } else {
        appendLog(logs, `[playwright] no storageState found for session=${request.session}`);
      }
    }

    context = await browser.newContext({
      ...contextOptions,
      viewport: request.viewport || { width: 1280, height: 800 },
      userAgent: request.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      bypassCSP: true,
      proxy: request.proxy
    });
    const page = await context.newPage();

    // Kill Service Workers for performance on slow networks
    await page.addInitScript(() => {
      // @ts-ignore
      if (window.navigator && window.navigator.serviceWorker) {
        // @ts-ignore
        delete window.navigator.serviceWorker;
      }
    });

    if (request.blockResources && request.blockResources.length > 0) {
      const blockedTypes = new Set(request.blockResources);
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (blockedTypes.has(type as any)) {
          return route.abort();
        }
        return route.continue();
      });
    }

    page.setDefaultTimeout(Math.min(30_000, request.timeoutMs));
    page.on('console', (message: { type: () => string; text: () => string }) => {
      appendLog(logs, `[browser:console:${message.type()}] ${truncate(message.text(), 500)}`);
    });
    page.on('pageerror', (error: { message: string }) => {
      appendLog(logs, `[browser:pageerror] ${truncate(error.message, 500)}`);
    });

    const deadline = startedAt + request.timeoutMs;

    for (let i = 0; i < request.actions.length; i += 1) {
      const action = request.actions[i];
      const stepLabel = `${i + 1}/${request.actions.length} ${action.action}`;

      const stepStartedAt = Date.now();
      appendLog(logs, `[step] start ${stepLabel}`);

      try {
        await executeAction({
          action,
          context,
          page,
          outputs,
          jobId,
          index: i,
          deadline,
          logs,
          config,
          jobOutputDir,
          jobTmpDir
        });
      } catch (error: unknown) {
        throw normalizeActionError(error, action, i);
      }

      appendLog(logs, `[step] done ${stepLabel} took_ms=${Date.now() - stepStartedAt}`);
    }

    await context.close();
    context = undefined;
    await browser.close();

    const tookMs = Date.now() - startedAt;
    appendLog(logs, `[playwright] success job=${jobId} took_ms=${tookMs}`);

    return {
      ok: true,
      jobId,
      tookMs,
      outputs,
      logs
    };
  } catch (error: unknown) {
    const tookMs = Date.now() - startedAt;
    const message = getErrorMessage(error);
    const statusCode = resolveStatusCode(error);
    const details = error instanceof PlaywrightHttpError ? error.details : undefined;

    appendLog(logs, `[playwright] error job=${jobId} status=${statusCode} message=${message}`);

    throw new PlaywrightJobError({
      message,
      statusCode,
      jobId,
      tookMs,
      logs,
      details
    });
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }

    if (browser) {
      await browser.close().catch(() => {});
    }

    if (tmpPathToCleanup) {
      await fs.rm(tmpPathToCleanup, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function executeAction(options: {
  action: PlaywrightAction;
  context: BrowserContextLike;
  page: PageLike;
  outputs: PlaywrightJobOutputs;
  jobId: string;
  index: number;
  deadline: number;
  logs: string[];
  config: PlaywrightRunnerConfig;
  jobOutputDir: string;
  jobTmpDir: string;
}): Promise<void> {
  const {
    action,
    context,
    page,
    outputs,
    jobId,
    deadline,
    logs,
    config,
    jobOutputDir,
    jobTmpDir
  } = options;

  ensureTimeRemaining(deadline, action.action);

  switch (action.action) {
    case 'goto': {
      const timeout = resolveStepTimeout(deadline);
      await page.goto(action.url, {
        waitUntil: action.waitUntil || 'domcontentloaded',
        timeout
      });
      return;
    }

    case 'click': {
      await page.click(action.selector, {
        timeout: resolveStepTimeout(deadline),
        ...(action.delayMs !== undefined ? { delay: action.delayMs } : {})
      });
      return;
    }

    case 'fill': {
      await page.fill(action.selector, action.text, {
        timeout: resolveStepTimeout(deadline)
      });
      return;
    }

    case 'press': {
      await page.press(action.selector, action.key, {
        timeout: resolveStepTimeout(deadline)
      });
      return;
    }

    case 'waitFor': {
      const timeout = resolveStepTimeout(deadline, action.timeoutMs);
      if (action.selector) {
        await page.waitForSelector(action.selector, {
          timeout,
          state: action.state || 'visible'
        });
      } else {
        await page.waitForTimeout(Math.max(1, timeout));
      }
      return;
    }

    case 'upload': {
      const localPath = resolveLocalUploadPath(action.path);
      const stat = await fs.stat(localPath).catch(() => null);

      if (!stat || !stat.isFile()) {
        throw new PlaywrightHttpError(400, `Arquivo local nao encontrado para upload: ${action.path}`);
      }

      await page.setInputFiles(action.selector, localPath, {
        timeout: resolveStepTimeout(deadline)
      });
      return;
    }

    case 'uploadFromUrl': {
      const download = await downloadImageFromUrl({
        url: action.url,
        destinationDir: jobTmpDir,
        maxBytes: config.maxUploadBytes,
        timeoutMs: Math.min(resolveStepTimeout(deadline), config.maxUploadDownloadTimeoutMs),
        allowDomains: config.allowDomains
      });

      appendLog(logs, `[step] uploadFromUrl downloaded bytes=${download.bytes} file=${download.fileName}`);

      await page.setInputFiles(action.selector, download.filePath, {
        timeout: resolveStepTimeout(deadline)
      });
      return;
    }

    case 'screenshot': {
      const desiredFileName = sanitizeArtifactFilename(action.name);
      const fileName = await resolveUniqueFileName(jobOutputDir, desiredFileName);
      const absoluteFilePath = path.join(jobOutputDir, fileName);

      await page.screenshot({
        path: absoluteFilePath,
        fullPage: Boolean(action.fullPage),
        timeout: resolveStepTimeout(deadline)
      });

      outputs.artifacts.push({
        name: action.name,
        filename: fileName,
        url: `${config.artifactsRoutePrefix}/${jobId}/${encodeURIComponent(fileName)}`
      });
      return;
    }

    case 'extractText': {
      const text = await page.textContent(action.selector, {
        timeout: resolveStepTimeout(deadline)
      });
      outputs.extracted[action.key] = String(text || '').trim();
      return;
    }

    case 'extractAttr': {
      const attr = await page.getAttribute(action.selector, action.attr, {
        timeout: resolveStepTimeout(deadline)
      });
      outputs.extracted[action.key] = String(attr || '');
      return;
    }

    case 'saveStorage': {
      const sessionPath = getSessionStatePath(config.storageDir, action.session);
      await context.storageState({ path: sessionPath });
      outputs.storage.push({
        session: action.session,
        file: path.basename(sessionPath)
      });
      appendLog(logs, `[step] saveStorage session=${action.session} file=${path.basename(sessionPath)}`);
      return;
    }

    case 'evaluate': {
      const result = await page.evaluate(action.script, action.arg);
      if (action.key) {
        outputs.extracted[action.key] = result;
      }
      appendLog(logs, `[step] evaluate script_len=${action.script.length} result=${JSON.stringify(result)}`);
      return;
    }

    default: {
      const neverAction: never = action;
      throw new PlaywrightHttpError(400, `Action nao suportada: ${(neverAction as { action?: string }).action}`);
    }
  }
}

function normalizeActionError(error: unknown, action: PlaywrightAction, index: number): PlaywrightHttpError {
  if (error instanceof PlaywrightHttpError) {
    return error;
  }

  const details = {
    step: index + 1,
    action: action.action,
    reason: getErrorMessage(error)
  };

  if (isPlaywrightTimeoutError(error)) {
    return new PlaywrightHttpError(
      504,
      `Timeout na action ${index + 1} (${action.action}).`,
      details
    );
  }

  return new PlaywrightHttpError(500, `Falha na action ${index + 1} (${action.action}).`, details);
}

function resolveStatusCode(error: unknown): number {
  if (error instanceof PlaywrightHttpError) {
    return error.statusCode;
  }

  if (isPlaywrightTimeoutError(error)) {
    return 504;
  }

  return 500;
}

function ensureTimeRemaining(deadline: number, actionName: string): void {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new PlaywrightHttpError(408, `Timeout total do job antes da action "${actionName}".`);
  }
}

function resolveStepTimeout(deadline: number, requestedTimeoutMs?: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new PlaywrightHttpError(408, 'Timeout total do job atingido.');
  }

  if (requestedTimeoutMs === undefined) {
    return remaining;
  }

  return Math.max(1, Math.min(requestedTimeoutMs, remaining));
}

async function resolveUniqueFileName(outputDir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const baseName = ext ? fileName.slice(0, -ext.length) : fileName;

  let candidate = fileName;
  let counter = 1;

  // Avoid overriding previous screenshots from same job.
  while (await fileExists(path.join(outputDir, candidate))) {
    candidate = `${baseName}-${counter}${ext}`;
    counter += 1;
  }

  return candidate;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function appendLog(logs: string[], message: string): void {
  logs.push(`${new Date().toISOString()} ${message}`);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...[truncated]`;
}
