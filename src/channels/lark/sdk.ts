import type { LarkChannel, LarkChannelOptions } from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import type { AppConfig } from '../../config/schema';
import { log } from '../../core/logger';
import type { LarkProfileAuth } from '../../lark-auth/profile-auth';

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

const SUPPRESSED_ENDPOINT_API_ERRORS = [
  {
    code: 99991672,
    urlPart: '/open-apis/wiki/v2/spaces/get_node',
  },
];

function codeFromObj(m: unknown): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const top = (m as { code?: unknown }).code;
  if (typeof top === 'number') return top;
  const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function urlFromObj(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const configUrl = (m as { config?: { url?: unknown } })?.config?.url;
  if (typeof configUrl === 'string') return configUrl;
  const requestPath = (m as { request?: { path?: unknown } })?.request?.path;
  return typeof requestPath === 'string' ? requestPath : undefined;
}

function isSuppressedSdkMessage(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some(isSuppressedSdkMessage);
  const code = codeFromObj(msg);
  if (code === undefined) return false;
  if (SUPPRESSED_API_ERROR_CODES.has(code)) return true;
  const url = urlFromObj(msg);
  return SUPPRESSED_ENDPOINT_API_ERRORS.some(
    (rule) => code === rule.code && url?.includes(rule.urlPart),
  );
}

export function shouldSuppressSdkErrorLog(args: unknown[]): boolean {
  return args.some(isSuppressedSdkMessage);
}

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  return {
    error: (...args: unknown[]) => {
      if (shouldSuppressSdkErrorLog(args)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export function createProfileChannel(cfg: AppConfig, larkAuth: LarkProfileAuth, appSecret: string): LarkChannel {
  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain:
      cfg.accounts.app.tenant === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn',
    source: 'lark-channel-bridge',
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Per-request REST timeout — without a cap a slow API can hang the
    // event-handling thread.
    httpTimeoutMs: 30_000,
    // Keep SDK REST/WS and native COT/auth requests on the same profile policy.
    httpInstance: larkAuth.network.httpInstance,
    agent: larkAuth.network.agent,
    respectProxyEnv: false,
  };

  return createLarkChannel(opts);
}
