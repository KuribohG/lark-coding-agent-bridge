import os from 'node:os';
import { getBuildInfo, type BuildInfo } from '../build-info';
import { readConfigRevision } from '../config/revision';
import { resolveAppPaths } from '../config/app-paths';
import { agentDisplayName } from '../agent/backend-spec';
import { isAlive, readAndPrune, type ProcessEntry } from './registry';

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
  matchesStatusBuild: boolean | null;
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
    buildMismatchCount: number;
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
    return {
      id: entry.id,
      pid: entry.pid,
      alive: isAlive(entry.pid),
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
      matchesStatusBuild: build.commit !== 'unknown' && buildCommit !== 'unknown'
        ? build.commit === buildCommit
        : null,
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
      buildMismatchCount: processes.filter((item) => item.matchesStatusBuild === false).length,
    },
  };
}

function defaultRegistryPath(): string {
  return resolveAppPaths().userRegistryFile;
}
