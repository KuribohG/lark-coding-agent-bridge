/**
 * Model-gate extension for Pi CLI runs.
 *
 * Pi runs the agent loop inside the CLI process, so the only exact place to
 * hold a quota is the provider-request boundary. This extension asks the
 * bridge's gate for a permit immediately before every provider request and
 * releases it when the assistant message is finalized — the permit is held
 * while the provider answers and nothing is held while tools run. Two hundred
 * agents can therefore be alive with only a hundred model requests in flight.
 *
 * It is built to `dist/pi-model-gate.mjs` and loaded with
 * `pi --extension <that file>`; the bridge passes `LARK_MODEL_GATE_SOCKET`,
 * for workers `LARK_MODEL_GATE_PRIORITY`, and for a provider it registered
 * itself `LARK_MODEL_GATE_PROVIDER_NAMES`.
 *
 * A limit belongs to a provider, so every model of one provider must ask under
 * one name. Pi reports the provider of a model from its own catalog by the
 * catalog's name, but a provider the bridge registered by the id the bridge
 * generated for it, which differs from model to model. The bridge therefore
 * passes the name behind each such id and the permit is asked under that.
 *
 * Nothing here may break a run: without the socket the extension is inert, and
 * an unreachable gate lets the request through (the provider's own rate limit
 * remains the backstop).
 */
import { request as httpRequest } from 'node:http';

/** The slice of Pi's extension API this file uses. */
interface GateExtensionApi {
  on(event: 'before_provider_request', handler: (event: unknown, ctx: GateContext) => Promise<void> | void): unknown;
  on(event: 'message_end', handler: (event: GateMessageEvent) => void): unknown;
  on(event: 'agent_end' | 'session_shutdown', handler: () => void): unknown;
}

interface GateContext {
  model?: { provider: string; id?: string };
  signal?: AbortSignal;
}

interface GateMessageEvent {
  message?: { role?: string };
}

export interface GateRequestOptions {
  socketPath: string;
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

export interface GateExtensionOptions {
  socketPath?: string;
  request?: (options: GateRequestOptions) => Promise<Record<string, unknown>>;
  /** Provider name by the id Pi reports for it; read from `LARK_MODEL_GATE_PROVIDER_NAMES` when omitted. */
  providerNames?: Record<string, string>;
}

const PRIORITY_DEFAULT = 0;

export default function modelGateExtension(pi: GateExtensionApi, options: GateExtensionOptions = {}): void {
  const socketPath = options.socketPath ?? process.env.LARK_MODEL_GATE_SOCKET;
  if (!socketPath) return;
  const parsedPriority = Number.parseInt(process.env.LARK_MODEL_GATE_PRIORITY ?? '', 10);
  const priority = Number.isFinite(parsedPriority) ? Math.max(0, Math.min(9, parsedPriority)) : PRIORITY_DEFAULT;
  const call = options.request ?? gateRequest;
  const names = new Map(Object.entries(options.providerNames ?? providerNamesFromEnv(process.env.LARK_MODEL_GATE_PROVIDER_NAMES))
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));

  /**
   * At most one permit per session: Pi's agent loop issues provider requests
   * one at a time. A second acquire therefore means the previous attempt
   * ended without its assistant message being finalized (a transport retry),
   * so its permit is handed back first instead of leaking until the lease.
   */
  let permit: string | undefined;
  let warned = false;

  const warn = (message: string, error: unknown): void => {
    if (warned) return;
    warned = true;
    const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error);
    // stderr only — stdout carries Pi's JSON protocol.
    console.error(`[model-gate] ${message}${detail ? `: ${detail}` : ''}`);
  };

  const release = (): void => {
    const held = permit;
    permit = undefined;
    if (!held) return;
    // Fire and forget; the gate also reclaims permits by lease.
    void call({ socketPath, path: '/release', body: { permit: held } }).catch(() => {});
  };

  pi.on('before_provider_request', async (_event, ctx) => {
    if (!ctx?.model) return;
    release();
    try {
      const granted = await call({
        socketPath,
        path: '/acquire',
        body: { provider: names.get(ctx.model.provider) ?? ctx.model.provider, priority },
        signal: ctx.signal,
      });
      if (typeof granted?.permit === 'string') permit = granted.permit;
    } catch (error) {
      // Fail open: a gate outage must not stop the bridge from working.
      warn('gate unreachable; continuing without a permit', error);
    }
  });

  // The response is complete once its assistant message is finalized — before
  // any tool call from that message runs, so tool execution holds nothing.
  pi.on('message_end', event => { if (event?.message?.role === 'assistant') release(); });
  pi.on('agent_end', release);
  pi.on('session_shutdown', release);
}

/** A malformed value leaves providers under the ids Pi reports, as without it. */
function providerNamesFromEnv(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** POST JSON over the gate's socket and resolve with its JSON answer. */
export function gateRequest({ socketPath, path, body, signal }: GateRequestOptions): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = httpRequest({
      socketPath,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`gate ${path} answered ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(text) as Record<string, unknown>); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) { req.destroy(signal.reason ?? new Error('aborted')); return; }
      const abort = (): void => { req.destroy(signal.reason ?? new Error('aborted')); };
      signal.addEventListener('abort', abort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', abort));
    }
    req.end(payload);
  });
}
