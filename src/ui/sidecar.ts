import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';

type UiSidecarSource = Pick<UiSidecar, 'url' | 'token' | 'port'>;

/**
 * Discovery record for a running bridge's local web-config server, written to
 * `<profileDir>/ui.json` (0600). The `ui` CLI command reads it to find the URL
 * + token of the live server and open the browser, instead of standing up its
 * own. `pid` lets the reader confirm the owning process is still alive.
 */
export interface UiSidecar {
  url: string;
  token: string;
  port: number;
  pid: number;
  startedAt: string;
}

export async function writeUiSidecar(
  uiFile: string,
  handle: UiSidecarSource,
  startedAt: string,
): Promise<void> {
  const record: UiSidecar = {
    url: handle.url,
    token: handle.token,
    port: handle.port,
    pid: process.pid,
    startedAt,
  };
  await mkdir(dirname(uiFile), { recursive: true });
  await writeFileAtomic(uiFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export async function readUiSidecar(uiFile: string): Promise<UiSidecar | undefined> {
  try {
    const parsed = JSON.parse(await readFile(uiFile, 'utf8')) as Partial<UiSidecar>;
    if (!parsed.url || !parsed.token || typeof parsed.port !== 'number') return undefined;
    return parsed as UiSidecar;
  } catch {
    return undefined;
  }
}

export async function removeUiSidecar(uiFile: string): Promise<void> {
  await rm(uiFile, { force: true }).catch((err) =>
    log.warn('ui', 'sidecar-remove-failed', { err: String(err) }),
  );
}

/**
 * Return the sidecar only when the listener it names is actually alive.
 *
 * A stale ui.json can outlive a crashed supervisor, and a stale pid can be
 * reused by an unrelated process. Authenticate the local listener instead of
 * trusting either record: the URL must stay on loopback, and /api/status must
 * echo the recorded pid with `hosted: true`. Never send the token anywhere
 * else.
 */
export async function liveConsole(uiFile: string): Promise<UiSidecar | undefined> {
  const record = await readUiSidecar(uiFile);
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) return;
  try {
    const url = new URL(record.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
        Number(url.port) !== record.port) return;
    const response = await fetch(new URL('/api/status', url), {
      headers: { 'x-ui-token': record.token }, redirect: 'error', signal: AbortSignal.timeout(1500),
    });
    const status = await response.json() as { pid?: number; hosted?: boolean };
    if (response.ok && status.hosted && status.pid === record.pid) return record;
  } catch { /* stale or not yet listening */ }
}
