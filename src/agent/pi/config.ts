import { normalizeExecutableLaunch, type ExecutableLaunchConfig } from '../launch-options';
import { normalizeWorkcell, type WorkcellConfig } from '../pi-sdk/workcell';

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
  /**
   * Run the SDK host on this ssh destination instead of the bridge machine.
   * `nodePath`, `sdkPath`, `hostScript` and `agentDir` must resolve to the same
   * paths there (a shared filesystem mount).
   */
  remote?: string;
  /** Extra ssh options, appended before the destination. */
  sshOptions?: string[];
  /**
   * Rent an isolated unit for this profile's host instead of running it on the
   * bridge machine. The provider is an executable; see workcell.ts.
   */
  workcell?: WorkcellConfig;
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
  if (input.remote !== undefined) {
    if (typeof input.remote !== 'string' || !input.remote.trim() || input.remote.startsWith('-') || /\s/.test(input.remote)) {
      throw new Error('pi.remote: expected an ssh destination such as "host" or "user@host"');
    }
  }
  if (input.sshOptions !== undefined && (!Array.isArray(input.sshOptions) || input.sshOptions.some(option => typeof option !== 'string'))) {
    throw new Error('pi.sshOptions: expected an array of strings');
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
    ...(input.remote ? { remote: input.remote.trim() } : {}),
    ...(input.sshOptions && input.sshOptions.length > 0 ? { sshOptions: [...input.sshOptions] } : {}),
    ...(input.workcell ? { workcell: normalizeWorkcell(input.workcell) } : {}),
  };
}
