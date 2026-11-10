import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorkflowCaller } from './types';

const MAX_BODY = 512_000;

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

  /** `endpointFile` publishes the current endpoint to workers started by an earlier process, whose environment names its port. */
  constructor(call: (caller: WorkflowCaller, method: string, args: Record<string, unknown>) => Promise<unknown>, private readonly cliPath?: string,
    private readonly endpointFile?: string) {
    this.server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      try {
        if (request.method !== 'POST' || request.url !== '/workflow') throw new Error('Invalid workflow endpoint');
        const tokenHash = workflowTokenHash(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
        const binding = this.bindings.get(tokenHash);
        if (!binding || binding.expiresAt <= Date.now()) {
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
        const result = await call(binding.caller, body.method, body.args as Record<string, unknown>);
        response.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        if (response.statusCode === 200) response.statusCode = 400;
        response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
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

  async close(): Promise<void> {
    this.bindings.clear();
    this.server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
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

export async function callWorkflow(method: string, args: unknown, env = process.env): Promise<unknown> {
  const endpoint = workflowEndpoint(env);
  const token = env.AGENT_WORKFLOW_TOKEN;
  if (!endpoint || !token) throw new Error('This command requires a bridge-managed workflow run');
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/workflow' || url.username || url.password) throw new Error('Invalid local workflow endpoint');
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
  const body = await response.json() as { ok: boolean; result?: unknown; error?: string };
  if (!body.ok) throw new Error(body.error ?? 'Workflow request failed');
  return body.result;
}
