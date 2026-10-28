import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeModelService, normalizeModelServices, type ModelServiceConfig } from '../../../src/model-service/config';
import { loadModelService } from '../../../src/model-service/service';
import { checkModelService, configureModelService, listModelServices, removeModelService } from '../../../src/model-service/registry';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { normalizeInbox } from '../../../src/inbox/config';
import { inboxTriageSource, loadInboxTriageSource } from '../../../src/inbox/model-routing';
import { triageWithChatTools } from '../../../src/monitoring/sources/lark/codex-triage';
import type { InboxJob } from '../../../src/inbox/types';
import { removeService as removeServiceCli } from '../../../src/cli/commands/model-service';

const service: ModelServiceConfig = { protocol: 'responses', baseUrl: 'https://model.test/v1/', model: 'screen-default', apiKey: { source: 'env', id: 'TEST_MODEL_KEY' } };
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'model-services-')); dirs.push(dir);
  const root = createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'test', secret: 'fixture', tenant: 'feishu' } } }));
  const configPath = join(dir, 'config.json'); await saveRootConfig(root, configPath);
  vi.stubEnv('TEST_MODEL_KEY', 'private-fixture');
  return { dir, root, configPath };
}

it('uses an independent service with no Codex profile and its own model default', async () => {
  const h = await setup(); h.root.modelServices = { screen: service };
  const config = normalizeInbox({ executorProfile: 'claude', triageService: 'screen', analysisModel: 'sonnet', triageProfile: 'nonexistent' });
  const source = inboxTriageSource(config, h.root);
  const provider = await loadInboxTriageSource(config, source, h.dir);
  expect(provider).toMatchObject({ model: 'screen-default', url: 'https://model.test/v1/responses', key: 'private-fixture' });
  expect((await loadInboxTriageSource({ ...config, triageModel: 'override' }, source)).model).toBe('override');
  expect((await loadInboxTriageSource({ ...config, triageModel: '' }, source)).model).toBe('screen-default');
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ id: 'a', state: 'quiet', reason: 'verified', priority: 'normal' }) }] }] }), { headers: { 'content-type': 'application/json' } }));
  const result = await triageWithChatTools({ id: 'a', ownerKey: 'ou_owner',
    sourceRef: { transport: 'lark', containerId: 'oc_test', name: 'test', kind: 'direct' }, messages: [] } as unknown as InboxJob, '', provider,
    { execute: vi.fn() }, new AbortController().signal, undefined, request);
  expect(result).toMatchObject({ id: 'a', state: 'quiet' });
  expect(request.mock.calls[0]![0]).toBe('https://model.test/v1/responses');
  expect(request.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer private-fixture' } });
  expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).model).toBe('screen-default');
});

it('never falls back to profile or global credentials for a missing service or key', async () => {
  const h = await setup(); h.root.modelServices = { screen: service };
  vi.stubEnv('OPENAI_API_KEY', 'unrelated-private-key'); vi.stubEnv('TEST_MODEL_KEY', undefined);
  const config = normalizeInbox({ executorProfile: 'claude', triageService: 'missing' });
  expect(() => inboxTriageSource(config, h.root)).toThrow('找不到所选');
  await expect(loadInboxTriageSource({ ...config, triageService: 'screen' }, { kind: 'service', config: service })).rejects.toThrow('凭据缺失');
});

it('reads file and header references at request time without serializing their values', async () => {
  const h = await setup(); const file = join(h.dir, 'key'); await writeFile(file, 'first-private-key\n');
  const config: ModelServiceConfig = { ...service, apiKey: { source: 'file', id: file }, headers: { 'X-Tenant': { source: 'env', id: 'TEST_MODEL_TENANT' } } };
  vi.stubEnv('TEST_MODEL_TENANT', 'tenant-fixture');
  await configureModelService(h.configPath, 'screen', config);
  expect(await checkModelService(h.configPath, 'screen')).toEqual({ model: 'screen-default', note: expect.stringContaining('尚未请求') });
  expect((await loadModelService(config)).headers).toEqual({ 'X-Tenant': 'tenant-fixture' });
  expect((await loadModelService(config)).key).toBe('first-private-key');
  await writeFile(file, 'rotated-private-key\n'); expect((await loadModelService(config)).key).toBe('rotated-private-key');
  expect(await readFile(h.configPath, 'utf8')).not.toMatch(/first-private-key|rotated-private-key|tenant-fixture/);
  expect(JSON.stringify(await listModelServices(h.configPath))).not.toContain('rotated-private-key');
});

it('preserves the registry on profile writes and serializes concurrent service edits', async () => {
  const h = await setup();
  await Promise.all([configureModelService(h.configPath, 'a', service), configureModelService(h.configPath, 'b', { ...service, model: 'second' })]);
  const root = (await loadRootConfig(h.configPath))!;
  root.profiles.claude!.preferences.model = 'sonnet'; await saveRootConfig(root, h.configPath);
  expect(Object.keys(await listModelServices(h.configPath)).sort()).toEqual(['a', 'b']);
  root.inbox = normalizeInbox({ enabled: false, executorProfile: 'claude', triageService: 'a' }); await saveRootConfig(root, h.configPath);
  await removeModelService(h.configPath, 'a');
  expect(Object.keys(await listModelServices(h.configPath))).toEqual(['b']);
  await configureModelService(h.configPath, 'a', service);
  await removeModelService(h.configPath, 'b'); expect(Object.keys(await listModelServices(h.configPath))).toEqual(['a']);
});

it('blocks CLI removal while a plugin references the service', async () => {
  const h = await setup();
  await configureModelService(h.configPath, 'screen', service);
  const root = (await loadRootConfig(h.configPath))!;
  root.inbox = normalizeInbox({
    enabled: false,
    executorProfile: 'claude',
    triageService: 'screen',
  });
  await saveRootConfig(root, h.configPath);
  await expect(removeServiceCli('screen', { config: h.configPath }))
    .rejects.toThrow('仍引用');
  expect((await listModelServices(h.configPath)).screen).toBeDefined();
});

it.each([
  { baseUrl: 'http://model.test/v1' }, { baseUrl: 'https://secret@model.test/v1' }, { baseUrl: 'https://model.test/v1?key=private' },
  { protocol: 'messages' }, { apiKey: 'literal-private-key' }, { apiKey: { source: 'exec', id: 'command' } },
  { apiKey: { source: 'file', id: 'relative' } }, { headers: { Authorization: { source: 'env', id: 'TEST_MODEL_KEY' } } },
  { headers: { 'X-Token': 'literal-private-key' } }, { model: '' }, { api_key: 'literal-private-key' },
])('rejects invalid configuration without echoing credentials (%j)', patch => {
  try { normalizeModelService({ ...service, ...patch }); throw new Error('unexpected success'); }
  catch (error) { expect(String(error)).not.toMatch(/literal-private-key|https:\/\/secret|key=private|unexpected success/); }
});

it('rejects unsafe registry keys and header duplicates', () => {
  expect(() => normalizeModelServices(JSON.parse('{"__proto__":{}}'))).toThrow();
  expect(() => normalizeModelService({ ...service, headers: { 'X-Key': service.apiKey, 'x-key': service.apiKey } })).toThrow('重复');
});

it('rejects invalid credential contents, missing files and directories with safe errors', async () => {
  const h = await setup(); const file = join(h.dir, 'key');
  for (const content of ['', 'private\r\ninjected', 'x'.repeat(65 * 1024)]) {
    await writeFile(file, content);
    const error = await loadModelService({ ...service, apiKey: { source: 'file', id: file } }).catch(e => e);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('injected');
  }
  await expect(loadModelService({ ...service, apiKey: { source: 'file', id: h.dir } })).rejects.toThrow(/普通文本文件|无法读取/);
  await expect(loadModelService({ ...service, apiKey: { source: 'file', id: join(h.dir, 'missing') } })).rejects.toThrow('无法读取');
});
