import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import type { ProfileConfig } from '../../config/profile-schema';
import type { ResponsesModelService } from '../../model-service/service';

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Reuse the selected Codex Responses provider without starting a tool-capable agent. */
export async function loadCodexModelService(profile: ProfileConfig, modelOverride?: string, profileDir?: string): Promise<ResponsesModelService> {
  const isolated = profile.codex?.inheritCodexHome === false && !profile.codex.codexHome;
  if (isolated && !profileDir) throw new Error('独立模型服务需要所选 profile 的配置目录');
  const home = profile.codex?.codexHome || (isolated ? join(profileDir!, 'codex-home') : process.env.CODEX_HOME || join(homedir(), '.codex'));
  let config: Record<string, unknown>;
  try { config = obj(parse(await readFile(join(home, 'config.toml'), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') config = {};
    else throw new Error('无法读取 Codex 模型配置，请检查配置文件格式');
  }
  const provider = obj(obj(config.model_providers)[String(config.model_provider || 'openai')]);
  if (provider.wire_api && provider.wire_api !== 'responses') throw new Error('助理需要 Responses 模型接口');
  let key = typeof provider.experimental_bearer_token === 'string' ? provider.experimental_bearer_token : '';
  if (!key && typeof provider.env_key === 'string') key = process.env[provider.env_key] || '';
  if (!key) key = process.env.OPENAI_API_KEY || '';
  if (!key) {
    try { key = String(obj(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))).OPENAI_API_KEY || ''); } catch { /* keychain-only auth needs a supported provider */ }
  }
  if (!key) throw new Error('助理尚无可用的 Responses API 凭证；普通 Codex 会话授权不能直接替代');
  const base = new URL(String(provider.base_url || 'https://api.openai.com/v1'));
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('模型地址必须是 HTTPS');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(provider.http_headers))) if (typeof v === 'string') headers[k] = v;
  for (const [k, v] of Object.entries(obj(provider.env_http_headers))) if (typeof v === 'string' && process.env[v]) headers[k] = process.env[v]!;
  // Callers own the model/cost policy; this loader only resolves routing and credentials.
  const model = modelOverride || profile.preferences.model || String(config.model || '');
  if (!model) throw new Error('请在 Codex 配置中设置默认模型');
  return { url: base.href.replace(/\/$/, '') + '/responses', model, key, headers };
}
