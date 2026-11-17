import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The gate the running bridge exposes to agent processes, if any. */
interface ModelGateTarget {
  socketPath: string;
}

let target: ModelGateTarget | undefined;

/**
 * The supervisor owns the gate; adapters ask this holder rather than threading
 * a bridge-wide service through every profile runtime. There is exactly one
 * per process, which is why a module-level holder is honest here.
 */
export function setModelGateTarget(next: ModelGateTarget | undefined): void {
  target = next;
}

export function currentModelGate(): ModelGateTarget | undefined {
  return target;
}

/**
 * Where the gate listens. One socket per bridge home, shared by every profile
 * in the process: the quota belongs to the provider, not to a profile.
 */
export function modelGateSocketPath(rootDir: string): string {
  if (process.platform === 'win32') {
    // Unix sockets do not exist here; a named pipe is the equivalent rendezvous.
    return `\\\\.\\pipe\\lark-model-gate-${createHash('sha256').update(rootDir).digest('hex').slice(0, 12)}`;
  }
  return join(rootDir, 'model-gate.sock');
}

/** The Pi CLI extension that asks for permits, resolved from src or dist. */
export function modelGateExtensionPath(): string {
  if (import.meta.url.endsWith('.ts')) {
    return fileURLToPath(new URL('./pi-gate-extension.ts', import.meta.url));
  }
  const bundled = fileURLToPath(new URL('./pi-model-gate.js', import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL('../dist/pi-model-gate.js', import.meta.url));
}
