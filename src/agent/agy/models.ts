import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { ProfileConfig } from '../../config/profile-schema';
import { spawnProcess, mergeProcessEnv } from '../../platform/spawn';
import { terminateChild } from '../../platform/terminate';
import { buildAgentEnvironment } from '../launch-env';
import type { ModelEnvironment } from '../model-settings';
import { supportedModels, validateModelId, type ModelOption } from '../models';

const cache = new Map<string, { expiresAt: number; value: Promise<ModelEnvironment> }>();

export function parseAgyModels(text: string): ModelOption[] {
  const models = new Map<string, ModelOption>();
  for (const line of stripVTControlCharacters(text).split(/\r?\n/)) {
    const match = /^\s*([a-zA-Z0-9][\w./:@+-]*)\s{2,}(\S.*)$/.exec(line);
    if (!match || ['id', 'model', 'slug'].includes(match[1]!.toLowerCase())) continue;
    try {
      const value = validateModelId(match[1]!);
      models.set(value, { value, label: match[2]!.trim() });
    } catch { /* Ignore headings and malformed catalog rows. */ }
  }
  return [...models.values()];
}

export async function readAgyModels(profile: ProfileConfig): Promise<ModelEnvironment> {
  const binary = profile.agy?.binaryPath ?? 'agy';
  const env = mergeProcessEnv(process.env, buildAgentEnvironment({}, profile.agy?.env));
  const key = createHash('sha256').update(JSON.stringify([binary, env])).digest('hex');
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.value;
  const fallback = { defaults: {}, models: supportedModels('agy') };
  const value = queryModels(binary, env).then(text => ({
    defaults: {}, models: [...fallback.models, ...parseAgyModels(text)],
  })).catch(() => fallback);
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, { expiresAt: Date.now() + 60_000, value });
  return value;
}

function queryModels(binary: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, ['models'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => {
      terminateChild(child, 'SIGKILL');
      reject(new Error('Antigravity model discovery timed out'));
    }, 5000);
    child.stdout!.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 1024 * 1024) {
        terminateChild(child, 'SIGKILL');
        reject(new Error('Antigravity model catalog is too large'));
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error('Antigravity model catalog unavailable'));
    });
  });
}
