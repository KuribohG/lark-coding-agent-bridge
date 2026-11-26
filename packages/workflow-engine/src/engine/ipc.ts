import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorkflowCaller } from './types';

const MAX_BODY = 512_000;
/**
 * Operations that answer only after the engine has finished work of its own; the others answer at once.
 * submit_work waits for its landing as long as its caller asked, an hour at most, and then says where the submission
 * is. configure_landing waits for the train in progress and for the new checks it tries on the branch, which may each
 * run for hours on a loaded host; six hours keeps that wait inside the worker's own tool deadline, which the scheduler
 * bounds at seven.
 */
const LONG_CALLS: Record<string, number> = { submit_work: 6 * 3_600_000, configure_landing: 6 * 3_600_000,
  // Checking out a worktree for each member it adds, or removing those of the members it cleans up, takes longer than
  // the others are given even for one member of a large repository. The caller that gave up was told nothing of an
  // addition that then went through, and its repeated call was refused while the first was still at work.
  staff_swarm: 3_600_000 };
const CALL_TIMEOUT_MS = 15_000;
/** While a long call is pending the response sends whitespace this often, which keeps the client's idle timers from firing. */
const KEEPALIVE_MS = 20_000;
/** How long a caller waits for a controller that is restarting before its call fails. */
const RESTART_WAIT_MS = 10 * 60_000;

/** The controller cannot answer now and its successor can: the caller repeats the call. */
class Restarting extends Error {
  constructor() { super('Workflow controller is restarting; repeat the same call'); }
}

function workflowTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Tokens are per run, carried in environment only, and never accepted from request parameters.
 * Only their hashes are kept, so a worker that outlives this process can be rebound by hash.
 */
export class WorkflowIpc {
  private readonly bindings = new Map<string, { caller: WorkflowCaller; expiresAt: number }>();
  private readonly server: Server;
  private endpoint = '';
  private closing = false;
  private interrupt!: () => void;
  /** Rejects when the service starts to close, for calls that would otherwise hold their connection open. */
  private readonly interrupted = new Promise<never>((_, reject) => { this.interrupt = () => reject(new Restarting()); });

  /**
   * `endpointFile` publishes the current endpoint to workers started by an earlier process, whose environment names its port.
   * `awaited` tells whether a token belongs to such a worker that this controller has yet to continue.
   */
  constructor(call: (caller: WorkflowCaller, method: string, args: Record<string, unknown>) => Promise<unknown>, private readonly cliPath?: string,
    private readonly endpointFile?: string, private readonly awaited?: (tokenHash: string) => boolean) {
    this.interrupted.catch(() => {});
    this.server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      let keepalive: NodeJS.Timeout | undefined;
      try {
        if (request.method !== 'POST' || request.url !== '/workflow') throw new Error('Invalid workflow endpoint');
        const tokenHash = workflowTokenHash(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
        const binding = this.bindings.get(tokenHash);
        if (!binding || binding.expiresAt <= Date.now()) {
          // A worker that outlives its controller keeps its token: the replay binds it again when it reaches the turn.
          if (!binding && (this.closing || this.awaited?.(tokenHash))) throw new Restarting();
          response.statusCode = 403;
          throw new Error('Workflow run binding is missing, expired or revoked');
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY) throw new Error('Workflow request exceeds size limit');
          chunks.push(Buffer.from(chunk));
        }
        if (this.bindings.get(tokenHash) !== binding) throw new Error('Workflow binding revoked');
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method?: unknown; args?: unknown };
        if (typeof body.method !== 'string' || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) throw new Error('Expected method and args object');
        const pending = call(binding.caller, body.method, body.args as Record<string, unknown>);
        let result: unknown;
        if (Object.hasOwn(LONG_CALLS, body.method)) {
          keepalive = setInterval(() => { response.write(' '); }, KEEPALIVE_MS);
          keepalive.unref();
          // A caller that outlives this process would keep the connection, and with it the shutdown, waiting for the
          // work to end. The work itself is stopped by the service that runs it.
          pending.catch(() => {});
          result = await Promise.race([pending, this.interrupted]);
        } else result = await pending;
        response.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        // What a closing service refuses or cuts short is asked again of the next one.
        const retry = this.closing || error instanceof Restarting;
        if (response.statusCode === 200 && !response.headersSent) response.statusCode = retry ? 503 : 400;
        response.end(JSON.stringify({ ok: false, ...(retry ? { retry: true } : {}), error: error instanceof Error ? error.message : String(error) }));
      } finally {
        clearInterval(keepalive);
      }
    });
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/workflow`;
    if (this.endpointFile) {
      const temporary = `${this.endpointFile}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ endpoint: this.endpoint }), { mode: 0o600 });
      renameSync(temporary, this.endpointFile);
    }
  }

  /** With `tokenHash`, accepts the token a still-running process already holds instead of issuing one. */
  bind(caller: WorkflowCaller, expiresAt: number, tokenHash?: string): { env: Record<string, string>; tokenHash: string; release(): void } {
    if (!this.endpoint) throw new Error('Workflow IPC is not listening');
    const token = tokenHash ? undefined : randomBytes(32).toString('hex');
    const key = tokenHash ?? workflowTokenHash(token!);
    const binding = { caller, expiresAt };
    this.bindings.set(key, binding);
    return {
      env: { AGENT_WORKFLOW_ENDPOINT: this.endpoint, ...(token ? { AGENT_WORKFLOW_TOKEN: token } : {}),
        ...(this.endpointFile ? { AGENT_WORKFLOW_ENDPOINT_FILE: this.endpointFile } : {}),
        ...(this.cliPath ? { AGENT_WORKFLOW_CLI: this.cliPath } : {}) },
      tokenHash: key,
      release: () => { if (this.bindings.get(key) === binding) this.bindings.delete(key); },
    };
  }

  /** Answers calls in flight and yet to come with a request to repeat them, so no caller holds the shutdown up. */
  beginClose(): void {
    this.closing = true;
    this.interrupt();
  }

  async close(): Promise<void> {
    this.beginClose();
    this.bindings.clear();
    // A caller that outlives this process keeps its connection open after its call was answered.
    const idle = setInterval(() => this.server.closeIdleConnections(), 50);
    try {
      await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    } finally { clearInterval(idle); }
  }
}

/** The published endpoint wins: the one in the environment belongs to the process that started this worker. */
function workflowEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  if (env.AGENT_WORKFLOW_ENDPOINT_FILE) {
    try {
      const { endpoint } = JSON.parse(readFileSync(env.AGENT_WORKFLOW_ENDPOINT_FILE, 'utf8')) as { endpoint?: unknown };
      if (typeof endpoint === 'string' && endpoint) return endpoint;
    } catch { /* not published yet; use the environment */ }
  }
  return env.AGENT_WORKFLOW_ENDPOINT;
}

export interface WorkflowCallOptions {
  /** How long to keep repeating a call that a restarting controller cannot answer. Defaults to ten minutes. */
  restartWaitMs?: number;
  /** Called once, when the call starts to wait for the controller. */
  onWait?(reason: string): void;
}

/**
 * Calls the controller of this run. A worker can outlive its controller: while the controller is down or has not
 * yet taken the worker's turn up again, the call is repeated against the published endpoint until it is answered.
 * Operations are idempotent under their operationId, so a call the old controller had begun is safe to repeat.
 */
export async function callWorkflow(method: string, args: unknown, env = process.env, options: WorkflowCallOptions = {}): Promise<unknown> {
  const token = env.AGENT_WORKFLOW_TOKEN;
  // Only a published endpoint moves to the next controller; without one there is nothing to wait for.
  const waitMs = env.AGENT_WORKFLOW_ENDPOINT_FILE ? options.restartWaitMs ?? RESTART_WAIT_MS : 0;
  // The wait starts when the controller is first missed, however long the call had been running by then.
  let waitUntil: number | undefined;
  for (let delay = 250; ; delay = Math.min(delay * 2, 5_000)) {
    const endpoint = workflowEndpoint(env);
    if (!endpoint || !token) throw new Error('This command requires a bridge-managed workflow run');
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/workflow' || url.username || url.password) throw new Error('Invalid local workflow endpoint');
    let failure: Error | undefined;
    try {
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(LONG_CALLS[method] ?? CALL_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
      const body = await response.json() as { ok: boolean; result?: unknown; error?: string; retry?: boolean };
      if (body.ok) return body.result;
      failure = new Error(body.error ?? 'Workflow request failed');
      if (!body.retry) throw failure;
    } catch (error) {
      // The controller answered, or the call ran out of time: neither is helped by asking again.
      if (error === failure || (error as Error)?.name === 'TimeoutError') throw error;
      // Anything else is a connection that was refused or cut: the controller is down or went down mid-call.
      failure ??= error instanceof Error ? error : new Error(String(error));
    }
    if (waitUntil === undefined) {
      waitUntil = Date.now() + waitMs;
      if (waitMs > 0) options.onWait?.(failure!.message);
    }
    if (Date.now() + delay > waitUntil) throw failure;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
