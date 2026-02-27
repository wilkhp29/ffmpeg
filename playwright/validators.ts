import { PlaywrightHttpError } from './errors';
import type { PlaywrightAction, PlaywrightRunRequest } from './types';

const WAIT_UNTIL_VALUES = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);
const WAIT_FOR_STATE_VALUES = new Set(['attached', 'detached', 'visible', 'hidden']);
const ACTION_NAMES = new Set([
  'goto',
  'click',
  'fill',
  'press',
  'waitFor',
  'upload',
  'uploadFromUrl',
  'screenshot',
  'extractText',
  'extractAttr',
  'saveStorage'
]);

export function parseAllowDomains(rawValue: string | undefined): string[] {
  if (!rawValue || !rawValue.trim()) {
    return [];
  }

  return Array.from(
    new Set(
      rawValue
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0)
    )
  );
}

export function validateSessionName(value: unknown, fieldName = 'session'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlaywrightHttpError(400, `Campo "${fieldName}" e obrigatorio.`);
  }

  const session = value.trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(session)) {
    throw new PlaywrightHttpError(
      400,
      `Campo "${fieldName}" invalido. Use apenas letras, numeros, ponto, underscore e hifen.`
    );
  }

  return session;
}

export function parseOptionalSession(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return validateSessionName(value, 'session');
}

export function assertAllowedDomain(urlValue: string, allowDomains: string[], fieldName: string): void {
  if (allowDomains.length === 0) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new PlaywrightHttpError(400, `Campo "${fieldName}" deve conter URL valida.`);
  }

  const host = parsed.hostname.toLowerCase();
  const isAllowed = allowDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));

  if (!isAllowed) {
    throw new PlaywrightHttpError(
      400,
      `Dominio bloqueado em "${fieldName}". Permitidos: ${allowDomains.join(', ')}`
    );
  }
}

export function parseRunRequestBody(
  body: unknown,
  options: {
    maxActions: number;
    defaultTimeoutMs: number;
    allowDomains: string[];
  }
): PlaywrightRunRequest {
  const payload = requireObject(body, 'body');
  const session = parseOptionalSession(payload.session);

  const timeoutMs = parseTimeoutMs(payload.timeoutMs, options.defaultTimeoutMs);
  const actionsRaw = resolveActionsArray(payload);

  if (actionsRaw.length === 0) {
    throw new PlaywrightHttpError(400, 'Envie pelo menos 1 action em "actions".');
  }

  if (actionsRaw.length > options.maxActions) {
    throw new PlaywrightHttpError(
      400,
      `Limite excedido: maximo de ${options.maxActions} actions por job.`
    );
  }

  const actions = actionsRaw.map((rawAction, index) =>
    parseAction(rawAction, index, options.allowDomains)
  );

  return {
    session,
    timeoutMs,
    actions
  };
}

function resolveActionsArray(payload: Record<string, unknown>): unknown[] {
  const actions = payload.actions;
  const commands = payload.commands;

  if (Array.isArray(actions)) {
    return actions;
  }

  if (Array.isArray(commands)) {
    return commands;
  }

  throw new PlaywrightHttpError(400, 'Campo "actions" deve ser um array.');
}

function parseAction(rawAction: unknown, index: number, allowDomains: string[]): PlaywrightAction {
  const actionPath = `actions[${index}]`;
  const normalized = normalizeActionObject(rawAction, actionPath);
  const actionName = String(normalized.action);

  if (!ACTION_NAMES.has(actionName)) {
    throw new PlaywrightHttpError(400, `${actionPath}.action invalida: "${actionName}".`);
  }

  switch (actionName) {
    case 'goto': {
      assertOnlyAllowedKeys(normalized, ['action', 'url', 'waitUntil'], actionPath);
      const url = requireHttpUrl(normalized.url, `${actionPath}.url`);
      assertAllowedDomain(url, allowDomains, `${actionPath}.url`);

      const waitUntil = parseOptionalEnum(
        normalized.waitUntil,
        WAIT_UNTIL_VALUES,
        `${actionPath}.waitUntil`
      ) as 'load' | 'domcontentloaded' | 'networkidle' | 'commit' | undefined;

      return {
        action: 'goto',
        url,
        ...(waitUntil ? { waitUntil } : {})
      };
    }

    case 'click': {
      assertOnlyAllowedKeys(normalized, ['action', 'selector', 'delayMs'], actionPath);
      const selector = requireNonEmptyString(normalized.selector, `${actionPath}.selector`);
      const delayMs = parseOptionalPositiveInteger(normalized.delayMs, `${actionPath}.delayMs`, 10_000);

      return {
        action: 'click',
        selector,
        ...(delayMs !== undefined ? { delayMs } : {})
      };
    }

    case 'fill': {
      assertOnlyAllowedKeys(normalized, ['action', 'selector', 'text'], actionPath);
      const selector = requireNonEmptyString(normalized.selector, `${actionPath}.selector`);
      const text = requireString(normalized.text, `${actionPath}.text`);

      return {
        action: 'fill',
        selector,
        text
      };
    }

    case 'press': {
      assertOnlyAllowedKeys(normalized, ['action', 'selector', 'key'], actionPath);
      const selector = requireNonEmptyString(normalized.selector, `${actionPath}.selector`);
      const key = requireNonEmptyString(normalized.key, `${actionPath}.key`);

      return {
        action: 'press',
        selector,
        key
      };
    }

    case 'waitFor': {
      assertOnlyAllowedKeys(normalized, ['action', 'selector', 'state', 'timeoutMs'], actionPath);
      const selector =
        normalized.selector === undefined || normalized.selector === null || normalized.selector === ''
          ? undefined
          : requireNonEmptyString(normalized.selector, `${actionPath}.selector`);

      const state = parseOptionalEnum(
        normalized.state,
        WAIT_FOR_STATE_VALUES,
        `${actionPath}.state`
      ) as 'attached' | 'detached' | 'visible' | 'hidden' | undefined;

      const timeoutMs = parseOptionalPositiveInteger(
        normalized.timeoutMs,
        `${actionPath}.timeoutMs`,
        120_000
      );

      if (!selector && timeoutMs === undefined) {
        throw new PlaywrightHttpError(
          400,
          `${actionPath}: informe "selector" e/ou "timeoutMs" para waitFor.`
        );
      }

      return {
        action: 'waitFor',
        ...(selector ? { selector } : {}),
        ...(state ? { state } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {})
      };
    }

    case 'upload': {
      assertOnlyAllowedKeys(normalized, ['action', 'selector', 'path'], actionPath);
      const selector = requireNonEmptyString(normalized.selector, `${actionPath}.selector`);
      const localPath = requireNonEmptyString(normalized.path, `${actionPath}.path`);

      return {
        action: 'upload',
        selector,
        path: localPath
      };
    }

    case 'uploadFromUrl': {
      assertOnlyAllowedKeys(normalized, ['action', 'selector', 'url'], actionPath);
      const selector = requireNonEmptyString(normalized.selector, `${actionPath}.selector`);
      const url = requireHttpUrl(normalized.url, `${actionPath}.url`);
      assertAllowedDomain(url, allowDomains, `${actionPath}.url`);

      return {
        action: 'uploadFromUrl',
        selector,
        url
      };
    }

    case 'screenshot': {
      assertOnlyAllowedKeys(normalized, ['action', 'name', 'fullPage'], actionPath);
      const name = requireNonEmptyString(normalized.name, `${actionPath}.name`);
      const fullPage = parseOptionalBoolean(normalized.fullPage, `${actionPath}.fullPage`);

      return {
        action: 'screenshot',
        name,
        ...(fullPage !== undefined ? { fullPage } : {})
      };
    }

    case 'extractText': {
      assertOnlyAllowedKeys(normalized, ['action', 'selector', 'key'], actionPath);
      const selector = requireNonEmptyString(normalized.selector, `${actionPath}.selector`);
      const key = requireNonEmptyString(normalized.key, `${actionPath}.key`);

      return {
        action: 'extractText',
        selector,
        key
      };
    }

    case 'extractAttr': {
      assertOnlyAllowedKeys(normalized, ['action', 'selector', 'attr', 'key'], actionPath);
      const selector = requireNonEmptyString(normalized.selector, `${actionPath}.selector`);
      const attr = requireNonEmptyString(normalized.attr, `${actionPath}.attr`);
      const key = requireNonEmptyString(normalized.key, `${actionPath}.key`);

      return {
        action: 'extractAttr',
        selector,
        attr,
        key
      };
    }

    case 'saveStorage': {
      assertOnlyAllowedKeys(normalized, ['action', 'session'], actionPath);
      const session = validateSessionName(normalized.session, `${actionPath}.session`);

      return {
        action: 'saveStorage',
        session
      };
    }

    default:
      throw new PlaywrightHttpError(400, `${actionPath}.action nao suportada.`);
  }
}

function normalizeActionObject(value: unknown, fieldName: string): Record<string, unknown> {
  const raw = requireObject(value, fieldName);
  if (typeof raw.action === 'string') {
    return raw;
  }

  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    throw new PlaywrightHttpError(
      400,
      `${fieldName} deve conter "action" ou formato curto { "acao": { ... } }.`
    );
  }

  const key = keys[0];
  const nested = raw[key];
  if (!ACTION_NAMES.has(key)) {
    throw new PlaywrightHttpError(400, `${fieldName} action curta invalida: "${key}".`);
  }

  const nestedObject = requireObject(nested, `${fieldName}.${key}`);
  return {
    action: key,
    ...nestedObject
  };
}

function parseTimeoutMs(value: unknown, defaultValue: number): number {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return parsePositiveInteger(value, 'timeoutMs', 600_000);
}

function parsePositiveInteger(value: unknown, fieldName: string, maxValue: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new PlaywrightHttpError(400, `Campo "${fieldName}" deve ser inteiro positivo.`);
  }

  if (parsed > maxValue) {
    throw new PlaywrightHttpError(400, `Campo "${fieldName}" excede limite de ${maxValue}.`);
  }

  return parsed;
}

function parseOptionalPositiveInteger(
  value: unknown,
  fieldName: string,
  maxValue: number
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return parsePositiveInteger(value, fieldName, maxValue);
}

function parseOptionalEnum(
  value: unknown,
  allowed: Set<string>,
  fieldName: string
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = String(value);
  if (!allowed.has(parsed)) {
    throw new PlaywrightHttpError(
      400,
      `Campo "${fieldName}" invalido. Aceitos: ${Array.from(allowed).join(', ')}`
    );
  }

  return parsed;
}

function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new PlaywrightHttpError(400, `Campo "${fieldName}" deve ser boolean.`);
  }

  return value;
}

function requireHttpUrl(value: unknown, fieldName: string): string {
  const url = requireNonEmptyString(value, fieldName);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PlaywrightHttpError(400, `Campo "${fieldName}" deve conter URL valida.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PlaywrightHttpError(400, `Campo "${fieldName}" deve usar http/https.`);
  }

  return url;
}

function assertOnlyAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  fieldName: string
): void {
  const allowed = new Set(allowedKeys);

  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new PlaywrightHttpError(400, `${fieldName} contem campo nao permitido: "${key}".`);
    }
  }
}

function requireObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlaywrightHttpError(400, `Campo "${fieldName}" deve ser objeto.`);
  }

  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlaywrightHttpError(400, `Campo "${fieldName}" e obrigatorio.`);
  }

  return value.trim();
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new PlaywrightHttpError(400, `Campo "${fieldName}" deve ser string.`);
  }

  return value;
}
