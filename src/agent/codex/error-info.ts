import type { AgentFailureKind } from '../types';

type ObjectValue = Record<string, unknown>;

const STRING_ERROR_VARIANTS = new Set([
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'rateLimitExceeded',
  'flexUnavailable',
  'serverOverloaded',
  'cyberPolicy',
  'misalignmentPolicyViolation',
  'tooManyDenials',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'other',
]);

const OBJECT_ERROR_VARIANTS = new Set([
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'activeTurnNotSteerable',
]);

export interface CodexErrorSummary {
  codexErrorInfo?: unknown;
  variant?: string;
  httpStatusCode?: number;
  failureKind?: AgentFailureKind;
}

export function summarizeCodexErrorInfo(value: unknown): CodexErrorSummary {
  const codexErrorInfo = findCodexErrorInfo(value);
  if (codexErrorInfo === undefined) return {};
  const variant = codexErrorVariant(codexErrorInfo);
  const httpStatusCode = codexHttpStatusCode(codexErrorInfo, variant);
  const failureKind = codexFailureKind(variant, httpStatusCode);
  return {
    codexErrorInfo,
    ...(variant ? { variant } : {}),
    ...(httpStatusCode !== undefined ? { httpStatusCode } : {}),
    ...(failureKind ? { failureKind } : {}),
  };
}

export function isActiveTurnNotSteerable(value: unknown): boolean {
  return codexErrorVariant(findCodexErrorInfo(value)) === 'activeTurnNotSteerable';
}

function findCodexErrorInfo(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    return STRING_ERROR_VARIANTS.has(value) || OBJECT_ERROR_VARIANTS.has(value) ? value : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  if (hasErrorVariant(record)) return record;
  for (const key of ['codexErrorInfo', 'error', 'data', 'turnError', 'turn', 'cause']) {
    const found = findCodexErrorInfo(record[key], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function codexErrorVariant(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return STRING_ERROR_VARIANTS.has(value) || OBJECT_ERROR_VARIANTS.has(value) ? value : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  return [...STRING_ERROR_VARIANTS, ...OBJECT_ERROR_VARIANTS].find((key) => key in record);
}

function codexHttpStatusCode(value: unknown, variant: string | undefined): number | undefined {
  if (!variant) return undefined;
  const record = asRecord(value);
  const nested = asRecord(record?.[variant]);
  const status = nested?.httpStatusCode;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

function codexFailureKind(
  variant: string | undefined,
  httpStatusCode: number | undefined,
): AgentFailureKind | undefined {
  if (httpStatusCode === 401 || httpStatusCode === 403) return 'authentication';
  if (httpStatusCode === 429) return 'rate_limit';
  switch (variant) {
    case 'rateLimitExceeded':
    case 'serverOverloaded':
    case 'flexUnavailable':
      return 'rate_limit';
    case 'sessionBudgetExceeded':
    case 'usageLimitExceeded':
      return 'quota';
    case 'unauthorized':
      return 'authentication';
    case 'contextWindowExceeded':
    case 'cyberPolicy':
    case 'misalignmentPolicyViolation':
    case 'tooManyDenials':
    case 'internalServerError':
    case 'badRequest':
    case 'threadRollbackFailed':
    case 'sandboxError':
    case 'other':
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts':
      return 'runtime';
    default:
      return undefined;
  }
}

function hasErrorVariant(record: ObjectValue): boolean {
  return [...STRING_ERROR_VARIANTS, ...OBJECT_ERROR_VARIANTS].some((key) => key in record);
}

function asRecord(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectValue
    : undefined;
}
