import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import pkg from '../package.json';

export interface BuildInfo {
  version: string;
  commit: string;
  builtAt: string;
  dirty?: boolean;
  entrypoint: string;
  nodeVersion: string;
  release?: string;
  releaseId?: string;
}

interface ReleaseInfo {
  commit?: unknown;
  createdAt?: unknown;
}

export function getBuildInfo(entrypoint = process.argv[1]): BuildInfo {
  const resolvedEntrypoint = resolveEntrypoint(entrypoint);
  const release = detectReleasePath(resolvedEntrypoint);
  const releaseInfo = release ? readReleaseInfo(release) : undefined;
  const commit = clean(process.env.LARK_BUILD_COMMIT)
    ?? clean(releaseInfo?.commit)
    ?? 'unknown';
  const builtAt = clean(process.env.LARK_BUILD_TIME)
    ?? clean(releaseInfo?.createdAt)
    ?? 'unknown';
  const dirty = parseBoolean(process.env.LARK_BUILD_DIRTY)
    ?? (release ? false : undefined);
  return {
    version: pkg.version,
    commit,
    builtAt,
    ...(dirty !== undefined ? { dirty } : {}),
    entrypoint: resolvedEntrypoint,
    nodeVersion: process.version,
    ...(release ? { release, releaseId: basename(release) } : {}),
  };
}

export function formatBuildVersion(info: BuildInfo = getBuildInfo()): string {
  return info.commit === 'unknown'
    ? info.version
    : `${info.version} (${info.commit.slice(0, 12)}${info.dirty ? '-dirty' : ''})`;
}

export function detectReleasePath(entrypoint: string): string | undefined {
  let current = dirname(entrypoint);
  for (;;) {
    if (basename(dirname(current)) === 'releases') return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolveEntrypoint(entrypoint: string | undefined): string {
  if (!entrypoint) return '';
  try {
    return realpathSync(entrypoint);
  } catch {
    return entrypoint;
  }
}

function readReleaseInfo(release: string): ReleaseInfo | undefined {
  const path = join(release, 'release-info.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ReleaseInfo;
  } catch {
    return undefined;
  }
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
