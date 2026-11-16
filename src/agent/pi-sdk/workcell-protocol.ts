/**
 * The workcell provider protocol: what the bridge asks a provider to do, and
 * what the pool needs from one. Both the external client and the builtin ssh
 * provider implement this, so the pool never learns which kind answered.
 *
 * A provider rents isolated execution units. An external one is an executable
 * the bridge starts once per pool and drives with newline-delimited JSON; the
 * repository defines only this protocol, so which infrastructure fulfils it
 * stays the provider's business.
 *
 *   bridge -> provider  { id, op, ...params }
 *   provider -> bridge  { id, ok: true, data } | { id, ok: false, error }
 *                       { type: 'log', workcell?, line }
 *                       { type: 'exit', workcell?, code }
 */

export type WorkcellOp =
  | 'create'
  | 'push'
  | 'pull'
  | 'exec'
  | 'forward'
  | 'ttl'
  | 'stop';

export interface WorkcellCreateParams {
  image?: string;
  cpu?: number;
  memoryGb?: number;
  ttlSeconds?: number;
  network?: readonly ('lan' | 'www')[];
  /** Free-form labels the provider may use for naming or accounting. */
  labels?: Record<string, string>;
}

export interface WorkcellPushParams {
  workcell: string;
  local: string;
  remote: string;
  exclude?: readonly string[];
}

export interface WorkcellPullParams {
  workcell: string;
  remote: string;
  local: string;
}

export interface WorkcellExecParams {
  workcell: string;
  /** Shell script; providers run it through `bash` unless documented otherwise. */
  script: string;
  env?: Readonly<Record<string, string>>;
  detach?: boolean;
  /** Real path inside the unit, as `create` reported its root; a relative one is taken from that root. */
  cwd?: string;
  /** Seconds for a non-detached command; providers apply their own default. */
  timeout?: number;
}

export interface WorkcellForwardParams {
  workcell: string;
  /** Port the bridge wants to reach inside the workcell. */
  remotePort: number;
}

export interface WorkcellProviderFrame {
  type: string;
  workcell?: string;
  [key: string]: unknown;
}

/**
 * What the pool needs from a provider, whether it is an external program or a
 * builtin (`ssh://`). Ops and params are the protocol above.
 */
export interface WorkcellProvider {
  readonly isClosed: boolean;
  request<T = unknown>(op: WorkcellOp, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}
