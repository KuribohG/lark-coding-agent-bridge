import os from 'node:os';
import { getBuildInfo, type BuildInfo } from '../build-info';
import { readConfigRevision } from '../config/revision';
import { resolveAppPaths } from '../config/app-paths';
import { agentDisplayName } from '../agent/backend-spec';
import { isAlive, readAndPrune, type ProcessEntry } from './registry';
import { ACTIVITY_HEARTBEAT_MS, isIdleActivity, type RuntimeActivity } from './activity';

// Several missed heartbeats: the publisher is wedged or the process is gone.
const ACTIVITY_STALE_MS = 3 * ACTIVITY_HEARTBEAT_MS;

export interface BridgeStatusService {
  requested: 'profile' | 'supervisor' | 'unknown';
  profile?: string;
  platform?: string;
  servicePath?: string;
  state: string;
  pid?: number;
  lastExit?: number;
  lastRunAt?: string;
  source?: string;
  trigger?: string;
  error?: string;
}

export interface BridgeStatusProcess {
  id: string;
  pid: number;
  alive: boolean;
  online: boolean;
  managedByService: boolean | null;
  profile: string;
  agentKind: ProcessEntry['agentKind'];
  agentName: string;
  appId: string;
  tenant: string;
  botName?: string;
  startedAt: string;
  uptimeSeconds: number;
  version: string;
  buildCommit: string;
  buildTime: string;
  buildDirty?: boolean;
  nodeVersion?: string;
  entrypoint?: string;
  releasePath?: string;
  releaseId?: string;
  configPath: string;
  startupConfigRevision?: string;
  currentConfigRevision?: string;
  configFileChangedSinceStart: boolean | null;
  /** Revision the process last reconciled with; hot reload advances it. */
  appliedConfigRevision?: string;
  /** True when the file holds a revision the process has not accepted (invalid or not yet seen). */
  configFileChangedSinceApply: boolean | null;
  /** Settings waiting for /reconnect or a restart. */
  configPendingCount?: number;
  matchesStatusBuild: boolean | null;
  activity?: RuntimeActivity;
  activityAt?: string;
  /** No unfinished work in a fresh snapshot; null when the process publishes none or it went stale. */
  idle: boolean | null;
}

export interface BridgeStatusReport {
  schemaVersion: 1;
  generatedAt: string;
  host: {
    hostname: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  build: BuildInfo;
  service: BridgeStatusService | null;
  registry: {
    path: string;
    error?: string;
  };
  processes: BridgeStatusProcess[];
  summary: {
    processCount: number;
    onlineCount: number;
    serviceManagedCount: number;
    configChangedSinceStartCount: number;
    configNotAppliedCount: number;
    configPendingRestartCount: number;
    buildMismatchCount: number;
    busyCount: number;
    idleUnknownCount: number;
  };
}

export interface CollectBridgeStatusOptions {
  service?: BridgeStatusService;
  registryFile?: string;
}

export async function collectBridgeStatus(
  options: CollectBridgeStatusOptions = {},
): Promise<BridgeStatusReport> {
  const build = getBuildInfo();
  const registryPath = options.registryFile ?? defaultRegistryPath();
  let entries: ProcessEntry[] = [];
  let registryError: string | undefined;
  try {
    entries = readAndPrune(registryPath);
  } catch (error) {
    registryError = error instanceof Error ? error.message : String(error);
  }

  const revisionCache = new Map<string, string | undefined>();
  const processes = await Promise.all(entries.map(async (entry): Promise<BridgeStatusProcess> => {
    let currentConfigRevision: string | undefined;
    try {
      if (!revisionCache.has(entry.configPath)) {
        revisionCache.set(entry.configPath, await readConfigRevision(entry.configPath));
      }
      currentConfigRevision = revisionCache.get(entry.configPath);
    } catch {
      currentConfigRevision = undefined;
    }
    const startedMs = Date.parse(entry.startedAt);
    const buildCommit = entry.buildCommit ?? 'unknown';
    const alive = isAlive(entry.pid);
    return {
      id: entry.id,
      pid: entry.pid,
      alive,
      online: Boolean(entry.botName),
      managedByService: options.service
        ? options.service.state === 'running' && options.service.pid === entry.pid
        : null,
      profile: entry.profileName,
      agentKind: entry.agentKind,
      agentName: agentDisplayName(entry.agentKind),
      appId: entry.appId,
      tenant: entry.tenant,
      ...(entry.botName ? { botName: entry.botName } : {}),
      startedAt: entry.startedAt,
      uptimeSeconds: Number.isFinite(startedMs)
        ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000))
        : 0,
      version: entry.version,
      buildCommit,
      buildTime: entry.buildTime ?? 'unknown',
      ...(entry.buildDirty !== undefined ? { buildDirty: entry.buildDirty } : {}),
      ...(entry.nodeVersion ? { nodeVersion: entry.nodeVersion } : {}),
      ...(entry.entrypoint ? { entrypoint: entry.entrypoint } : {}),
      ...(entry.releasePath ? { releasePath: entry.releasePath } : {}),
      ...(entry.releaseId ? { releaseId: entry.releaseId } : {}),
      configPath: entry.configPath,
      ...(entry.startupConfigRevision
        ? { startupConfigRevision: entry.startupConfigRevision }
        : {}),
      ...(currentConfigRevision ? { currentConfigRevision } : {}),
      configFileChangedSinceStart: entry.startupConfigRevision && currentConfigRevision
        ? entry.startupConfigRevision !== currentConfigRevision
        : null,
      ...(entry.appliedConfigRevision ? { appliedConfigRevision: entry.appliedConfigRevision } : {}),
      configFileChangedSinceApply: currentConfigRevision && (entry.appliedConfigRevision ?? entry.startupConfigRevision)
        ? (entry.appliedConfigRevision ?? entry.startupConfigRevision) !== currentConfigRevision
        : null,
      ...(entry.configPendingCount !== undefined ? { configPendingCount: entry.configPendingCount } : {}),
      matchesStatusBuild: build.commit !== 'unknown' && buildCommit !== 'unknown'
        ? build.commit === buildCommit
        : null,
      ...(entry.activity ? { activity: entry.activity } : {}),
      ...(entry.activityAt ? { activityAt: entry.activityAt } : {}),
      idle: alive && entry.activity && isFresh(entry.activityAt) ? isIdleActivity(entry.activity) : null,
    };
  }));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
    },
    build,
    service: options.service ?? null,
    registry: {
      path: registryPath,
      ...(registryError ? { error: registryError } : {}),
    },
    processes,
    summary: {
      processCount: processes.length,
      onlineCount: processes.filter((item) => item.online).length,
      serviceManagedCount: processes.filter((item) => item.managedByService === true).length,
      configChangedSinceStartCount: processes.filter(
        (item) => item.configFileChangedSinceStart === true,
      ).length,
      configNotAppliedCount: processes.filter((item) => item.configFileChangedSinceApply === true).length,
      configPendingRestartCount: processes.filter((item) => (item.configPendingCount ?? 0) > 0).length,
      buildMismatchCount: processes.filter((item) => item.matchesStatusBuild === false).length,
      busyCount: processes.filter((item) => item.idle === false).length,
      idleUnknownCount: processes.filter((item) => item.idle === null).length,
    },
  };
}

function isFresh(at: string | undefined): boolean {
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) && Date.now() - ms <= ACTIVITY_STALE_MS;
}

function defaultRegistryPath(): string {
  return resolveAppPaths().userRegistryFile;
}
