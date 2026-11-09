import { summarizeCodexErrorInfo, type CodexErrorSummary } from './error-info';

export type ObjectValue = Record<string, unknown>;
export const object = (v: unknown): ObjectValue => v !== null && typeof v === 'object' ? v as ObjectValue : {};
export const text = (v: unknown): string => typeof v === 'string' ? v : '';

export class RpcError extends Error {
  readonly method: string;
  readonly code: unknown;
  readonly data: unknown;
  readonly codexError: CodexErrorSummary;

  constructor(message: string, input: {
    method: string;
    code?: unknown;
    data?: unknown;
    codexError?: CodexErrorSummary;
  }) {
    super(message);
    this.name = 'RpcError';
    this.method = input.method;
    this.code = input.code;
    this.data = input.data;
    this.codexError = input.codexError ?? {};
  }
}

interface PendingRequest {
  resolve(value: ObjectValue): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
  method: string;
}

/** JSON-RPC client over the app-server's newline-delimited stdio stream. */
export class AppServerRpc {
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly writeLine: (line: string) => void,
    private readonly isClosed: () => boolean,
  ) {}

  write(message: unknown): void {
    this.writeLine(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<ObjectValue> {
    if (this.isClosed()) return Promise.reject(new Error('app-server connection closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server ${method} acknowledgement timed out; delivery is unknown`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ id, method, params });
    });
  }

  handleResponse(id: number, message: ObjectValue): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (message.error) {
      const rpcError = object(message.error);
      const data = rpcError.data;
      p.reject(new RpcError(text(rpcError.message) || 'app-server rejected request', {
        method: p.method,
        code: rpcError.code,
        data,
        codexError: summarizeCodexErrorInfo(data),
      }));
    }
    else p.resolve(object(message.result));
  }

  /** Registers a request an earlier bridge process sent so its answer is still consumed. */
  restorePending(id: number, method: string, resolve: (result: ObjectValue) => void): void {
    this.nextId = Math.max(this.nextId, id);
    this.pending.set(id, { method, reject: () => {}, resolve });
  }

  failPending(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
}

export function rpcErrorFields(error: unknown): ObjectValue {
  if (error instanceof RpcError) {
    return {
      message: error.message,
      method: error.method,
      rpcCode: error.code,
      rpcData: error.data,
      ...error.codexError,
    };
  }
  return { message: errorMessage(error) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
