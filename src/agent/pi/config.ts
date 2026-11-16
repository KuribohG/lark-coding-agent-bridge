import { normalizeExecutableLaunch, type ExecutableLaunchConfig } from '../launch-options';

export interface PiConfig extends ExecutableLaunchConfig {
  /** Directory containing Pi settings, sessions, auth.json, and model catalogs. */
  agentDir?: string;
  /**
   * How runs reach Pi. `cli` (default) spawns one `pi --mode json` per run;
   * `sdk` embeds the Pi SDK in a long-lived host process that serves many
   * sessions and supports mid-run steering.
   */
  transport?: 'cli' | 'sdk';
  /** `@earendil-works/pi-coding-agent/dist/index.js`; derived from the launcher when omitted. */
  sdkPath?: string;
  /** Node >= 22.19 used for the SDK host; derived from the launcher/SDK tree when omitted. */
  nodePath?: string;
  /** Override the bundled bin/pi-host.mjs. */
  hostScript?: string;
  /** Dispose idle SDK sessions after this many milliseconds. */
  idleTtlMs?: number;
  /** Maximum sessions in one SDK host before evicting the least recently used idle session. */
  maxSessions?: number;
  /** Persist SDK sessions as JSONL (default) or keep them in memory only. */
  sessionPersistence?: 'file' | 'memory';
}

export function normalizePi(input: PiConfig): PiConfig {
  if (input.transport !== undefined && input.transport !== 'cli' && input.transport !== 'sdk') {
    throw new Error('pi.transport must be cli or sdk');
  }
  if (input.sessionPersistence !== undefined && input.sessionPersistence !== 'file' && input.sessionPersistence !== 'memory') {
    throw new Error('pi.sessionPersistence must be file or memory');
  }
  for (const key of ['idleTtlMs', 'maxSessions'] as const) {
    const value = input[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`pi.${key} must be a positive integer`);
    }
  }
  return {
    ...normalizeExecutableLaunch(input, 'pi'),
    ...(typeof input.agentDir === 'string' && input.agentDir ? { agentDir: input.agentDir } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(typeof input.sdkPath === 'string' && input.sdkPath ? { sdkPath: input.sdkPath } : {}),
    ...(typeof input.nodePath === 'string' && input.nodePath ? { nodePath: input.nodePath } : {}),
    ...(typeof input.hostScript === 'string' && input.hostScript ? { hostScript: input.hostScript } : {}),
    ...(typeof input.idleTtlMs === 'number' ? { idleTtlMs: input.idleTtlMs } : {}),
    ...(typeof input.maxSessions === 'number' ? { maxSessions: input.maxSessions } : {}),
    ...(input.sessionPersistence ? { sessionPersistence: input.sessionPersistence } : {}),
  };
}
