import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgyAdapter,
  ClaudeAdapter,
  CodexAdapter,
  ModelProviderRegistry,
  NATIVE_MODEL_PROVIDER,
  createBridgeWorkflowRuntime,
  isRegisteredAgentKind,
  normalizeModelService,
  probeAgentAuth,
  resolveAgentState,
  resolveWorkerExecution,
} from '../../../src/host';
import { agyProviderLaunch, bindAgyProvider, DEFAULT_AGY_CONTEXT_WINDOW } from '../../../src/agent/agy/provider';
import { prepareManagedCodexConfig } from '../../../src/agent/codex/managed-config';
import { checkRuntimeAgentAvailability } from '../../../src/runtime/agent-runtime';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { ProcessPool } from '../../../src/runtime/process-pool';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import type { AgentAdapter, AgentEvent } from '../../../src/agent/types';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import type { WorkerRunner, WorkflowRoot } from '@kuribohg/agent-workflows';
import { writeNodeFixtureLauncher } from '../../helpers/fake-executable';

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('per-harness auth hygiene and host exports', () => {
  it('exports all required host APIs from src/host.ts', () => {
    expect(AgyAdapter).toBeDefined();
    expect(ModelProviderRegistry).toBeDefined();
    expect(NATIVE_MODEL_PROVIDER).toBe('native');
    expect(normalizeModelService).toBeTypeOf('function');
    expect(isRegisteredAgentKind).toBeTypeOf('function');
    expect(resolveAgentState).toBeTypeOf('function');
    expect(probeAgentAuth).toBeTypeOf('function');
    expect(createBridgeWorkflowRuntime).toBeTypeOf('function');
    expect(resolveWorkerExecution).toBeTypeOf('function');
    expect(isRegisteredAgentKind('dsh')).toBe(true);
  });

  describe('claude authMode oauth vs api_key', () => {
    async function createFakeClaude(dir: string) {
      const recordPath = join(dir, 'claude-record.json');
      const script = join(dir, 'fake-claude.mjs');
      await writeFile(script, `
        import { readFileSync, writeFileSync } from 'node:fs';
        import { createInterface } from 'node:readline';
        const argv = process.argv.slice(2);
        if (argv.includes('--version')) { console.log('2.0.0'); process.exit(0); }
        const rl = createInterface({ input: process.stdin });
        rl.once('line', (line) => {
          const input = JSON.parse(line);
          writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
            argv,
            env: {
              ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
              ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
              ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
              CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
            },
          }));
          console.log(JSON.stringify({ ...input, isReplay: true }));
          console.log(JSON.stringify({ type: 'result', session_id: 'claude-1', result: 'ok', user_message_uuids: [input.uuid] }));
          process.exit(0);
        });
      `);
      const binary = await writeNodeFixtureLauncher(dir, 'fake-claude', script);
      return { binary, recordPath };
    }

    it('scrubs ambient API keys and preserves native ~/.claude (or explicit configDir) in oauth mode', async () => {
      const dir = await tempDir('claude-oauth-');
      const { binary, recordPath } = await createFakeClaude(dir);
      vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-key');
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-token');
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ambient.example');

      const oauthDefault = new ClaudeAdapter({ binary, authMode: 'oauth' });
      const run1 = (await oauthDefault.prepareRun({ runId: 'r1', cwd: dir, prompt: 'hi' })).start();
      await collect(run1.events);
      const record1 = JSON.parse(await readFile(recordPath, 'utf8'));
      expect(record1.env).toEqual({});
      expect(process.env.ANTHROPIC_API_KEY).toBe('ambient-key');

      const explicitConfigDir = join(dir, 'custom-claude');
      const oauthCustomDir = new ClaudeAdapter({ binary, authMode: 'oauth', configDir: explicitConfigDir });
      const run2 = (await oauthCustomDir.prepareRun({ runId: 'r2', cwd: dir, prompt: 'hi' })).start();
      await collect(run2.events);
      const record2 = JSON.parse(await readFile(recordPath, 'utf8'));
      expect(record2.env).toEqual({ CLAUDE_CONFIG_DIR: explicitConfigDir });
    });

    it('injects explicit key/token, baseUrl and model override without leaking to host env in api_key mode', async () => {
      const dir = await tempDir('claude-apikey-');
      const { binary, recordPath } = await createFakeClaude(dir);
      vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-key');
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-token');
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ambient.example');

      const adapter = new ClaudeAdapter({
        binary,
        authMode: 'api_key',
        apiKey: 'explicit-claude-key',
        baseUrl: 'https://gateway.internal/anthropic',
        model: 'claude-sonnet-4-6',
      });
      const prepared = await adapter.prepareRun({ runId: 'r1', cwd: dir, prompt: 'hi' });
      expect(prepared.modelSettings.model).toBe('claude-sonnet-4-6');
      await collect(prepared.start().events);

      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      expect(record.env).toEqual({
        ANTHROPIC_API_KEY: 'explicit-claude-key',
        ANTHROPIC_BASE_URL: 'https://gateway.internal/anthropic',
      });
      expect(record.argv).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-4-6']));
      expect(process.env.ANTHROPIC_API_KEY).toBe('ambient-key');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://ambient.example');

      await expect(new ClaudeAdapter({ binary, authMode: 'api_key' }).prepareRun({
        runId: 'r-missing',
        cwd: dir,
        prompt: 'hi',
      })).rejects.toThrow(/apiKey, authToken/);
    });
  });

  describe('codex authMode oauth vs api_key and allowHttp', () => {
    async function createFakeCodex(dir: string) {
      const recordPath = join(dir, 'codex-record.json');
      const script = join(dir, 'fake-codex.mjs');
      await writeFile(script, `
        import { writeFileSync } from 'node:fs';
        import { createInterface } from 'node:readline';
        const argv = process.argv.slice(2);
        if (argv.includes('--version')) { console.log('codex 0.166.0'); process.exit(0); }
        writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
          argv,
          env: {
            CODEX_HOME: process.env.CODEX_HOME,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
          },
        }));
        const rl = createInterface({ input: process.stdin });
        const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
        rl.on('line', (line) => {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') send({ id: msg.id, result: {} });
          if (msg.method === 'thread/start') send({ id: msg.id, result: { thread: { id: 'thread-1' } } });
          if (msg.method === 'turn/start') {
            send({ id: msg.id, result: { turn: { id: 'turn-1' } } });
            send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: 'done' } } });
            send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
          }
        });
      `);
      const binary = await writeNodeFixtureLauncher(dir, 'fake-codex', script);
      return { binary, recordPath };
    }

    it('rejects http:// model services by default and permits them with explicit allowHttp: true', async () => {
      const httpService = {
        protocol: 'responses',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'gateway-model',
        apiKey: { source: 'env', id: 'CODEX_HTTP_GW_KEY' },
      };
      expect(() => normalizeModelService(httpService)).toThrow('HTTPS');
      expect(() => normalizeModelService({ ...httpService, allowHttp: true })).toThrow();

      const normalized = normalizeModelService(httpService, { allowHttp: true });
      expect(normalized.baseUrl).toBe('http://127.0.0.1:8080/v1');

      vi.stubEnv('CODEX_HTTP_GW_KEY', 'gw-secret');
      const registry = new ModelProviderRegistry({ internal: normalized });
      const resolved = await registry.resolve('codex', 'internal/gateway-model');
      expect(resolved?.codex?.baseUrl).toBe('http://127.0.0.1:8080/v1');
      expect(resolved?.env?.[resolved.codex!.apiKeyEnv]).toBe('gw-secret');
    });

    it('uses native ~/.codex and scrubs OPENAI_API_KEY / OPENAI_BASE_URL in oauth mode', async () => {
      const dir = await tempDir('codex-oauth-');
      const stateDir = join(dir, 'state');
      const { binary, recordPath } = await createFakeCodex(dir);
      vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key');
      vi.stubEnv('OPENAI_BASE_URL', 'https://ambient.openai.example/v1');
      vi.stubEnv('CODEX_HOME', undefined);

      const layout = resolveAgentState({
        agentKind: 'codex',
        codex: { binaryPath: binary, authMode: 'oauth' },
        state: { bridgeRoot: stateDir },
      }, 'codex', { env: {} });
      expect(layout).toMatchObject({ home: join(homedir(), '.codex'), homeSource: 'native', exportHome: false });

      const adapter = new CodexAdapter({ binary, profileStateDir: stateDir, authMode: 'oauth' });
      const run = (await adapter.prepareRun({ runId: 'r-oauth', cwd: dir, prompt: 'hi' })).start();
      await collect(run.events);

      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      expect(record.env.CODEX_HOME).toBe(join(homedir(), '.codex'));
      expect(record.env.OPENAI_API_KEY).toBeUndefined();
      expect(record.env.OPENAI_BASE_URL).toBeUndefined();
    });

    it('always isolates codexHome in api_key mode and supports http:// baseUrl without touching ~/.codex', async () => {
      const dir = await tempDir('codex-apikey-');
      const stateDir = join(dir, 'state');
      const { binary, recordPath } = await createFakeCodex(dir);
      vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key');
      vi.stubEnv('OPENAI_BASE_URL', 'https://ambient.openai.example/v1');

      const layout = resolveAgentState({
        agentKind: 'codex',
        codex: { binaryPath: binary, authMode: 'api_key', inheritCodexHome: true },
        state: { bridgeRoot: stateDir },
      }, 'codex', { profileDir: stateDir });
      expect(layout.exportHome).toBe(true);
      expect(layout.home).toBe(join(stateDir, 'agents', 'codex'));

      expect(() => resolveAgentState({
        agentKind: 'codex',
        codex: { binaryPath: binary, authMode: 'api_key', codexHome: join(homedir(), '.codex') },
      }, 'codex')).toThrow('isolated codexHome');

      expect(() => new CodexAdapter({
        binary,
        profileStateDir: stateDir,
        authMode: 'api_key',
        codexHome: join(homedir(), '.codex'),
      })).toThrow('isolated codexHome');

      // prepareManagedCodexConfig in readOnly mode never writes config.toml even when passed a custom home.
      const roDir = join(dir, 'ro-home');
      await mkdir(roDir, { recursive: true });
      const roResult = await prepareManagedCodexConfig(roDir, undefined, { readOnly: true });
      expect(roResult.changed).toBe(false);

      const adapter = new CodexAdapter({
        binary,
        profileStateDir: stateDir,
        authMode: 'api_key',
        inheritCodexHome: true, // forced isolated in api_key mode
        apiKey: 'explicit-openai-key',
        baseUrl: 'http://127.0.0.1:9090/v1',
        model: 'gpt-5-codex',
      });
      const prepared = await adapter.prepareRun({ runId: 'r-apikey', cwd: dir, prompt: 'hi' });
      expect(prepared.modelSettings.model).toBe('gpt-5-codex');
      await collect(prepared.start().events);

      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      expect(record.env.CODEX_HOME).toBe(join(stateDir, 'codex-home'));
      expect(record.env.OPENAI_API_KEY).toBe('explicit-openai-key');
      expect(record.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:9090/v1');
      expect(record.argv.join(' ')).toContain('http://127.0.0.1:9090/v1');
      const isolatedConfig = await readFile(join(stateDir, 'codex-home', 'config.toml'), 'utf8');
      expect(isolatedConfig).toContain('http://127.0.0.1:9090/v1');
      expect(isolatedConfig).not.toContain('explicit-openai-key');
    });
  });

  describe('agy authMode oauth vs api_key and default contextWindow', () => {
    async function createFakeAgy(dir: string) {
      const recordPath = join(dir, 'agy-record.json');
      const script = join(dir, 'fake-agy.mjs');
      await writeFile(script, `
        import { writeFileSync } from 'node:fs';
        const argv = process.argv.slice(2);
        if (argv.includes('--version')) { console.log('1.4.10'); process.exit(0); }
        let input = '';
        process.stdin.on('data', (c) => { input += c; });
        process.stdin.on('end', () => {
          writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
            argv,
            env: {
              GEMINI_API_KEY: process.env.GEMINI_API_KEY,
              GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL,
            },
          }));
          console.log(JSON.stringify({ event: 'init', conversation_id: 'agy-1', init: {} }));
          console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'agy-1', response: 'ok' } }));
        });
      `);
      const binary = await writeNodeFixtureLauncher(dir, 'fake-agy', script);
      return { binary, recordPath };
    }

    it('applies a sensible default contextWindow when omitted in bindAgyProvider / agyProviderLaunch', () => {
      const bound = bindAgyProvider({
        providerId: 'lark_gw',
        id: 'gw',
        displayName: 'Gateway',
        model: 'gemini-2.5-flash',
        baseUrl: 'https://gw.example',
        apiKeyEnv: 'GW_KEY',
        headersEnv: {},
        env: { GW_KEY: 'secret-key' },
      });
      expect(bound.agy?.contextWindow).toBe(DEFAULT_AGY_CONTEXT_WINDOW);
      const launch = agyProviderLaunch(bound);
      expect(launch.settings.customModelsConfig.customModels.lark_gw?.maxTokens).toBe(DEFAULT_AGY_CONTEXT_WINDOW);
    });

    it('scrubs GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL in oauth mode and supports api_key mode cleanly', async () => {
      const dir = await tempDir('agy-auth-');
      const { binary, recordPath } = await createFakeAgy(dir);
      vi.stubEnv('GEMINI_API_KEY', 'ambient-gemini-key');
      vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://ambient.gemini.example');

      const oauthAdapter = new AgyAdapter({ binary, authMode: 'oauth' });
      await collect((await oauthAdapter.prepareRun({ runId: 'r-oauth', cwd: dir, prompt: 'hi' })).start().events);
      const oauthRecord = JSON.parse(await readFile(recordPath, 'utf8'));
      expect(oauthRecord.env).toEqual({});
      expect(process.env.GEMINI_API_KEY).toBe('ambient-gemini-key');

      const apiKeyAdapter = new AgyAdapter({
        binary,
        authMode: 'api_key',
        apiKey: 'explicit-gemini-key',
        baseUrl: 'https://gemini-gw.example',
        model: 'google/gemini-2.5-flash',
      });
      await collect((await apiKeyAdapter.prepareRun({ runId: 'r-apikey', cwd: dir, prompt: 'hi' })).start().events);
      const apiKeyRecord = JSON.parse(await readFile(recordPath, 'utf8'));
      expect(apiKeyRecord.env).toEqual({
        GEMINI_API_KEY: 'explicit-gemini-key',
        GOOGLE_GEMINI_BASE_URL: 'https://gemini-gw.example',
      });
      expect(apiKeyRecord.argv).toEqual(expect.arrayContaining(['--model', 'google/gemini-2.5-flash']));
      const settings = JSON.parse(apiKeyRecord.argv[apiKeyRecord.argv.indexOf('--settings') + 1]);
      expect(settings.modelProvider).toBe('gemini');
      expect(settings.customModelsConfig.customModels['google/gemini-2.5-flash'].maxTokens).toBe(DEFAULT_AGY_CONTEXT_WINDOW);
    });
  });

  describe('probeAgentAuth', () => {
    it('probes claude auth status --json with OAuth-scrubbed env', async () => {
      const dir = await tempDir('probe-claude-');
      const seenPath = join(dir, 'seen.json');
      const script = join(dir, 'claude-probe.mjs');
      await writeFile(script, `
        import { writeFileSync } from 'node:fs';
        const argv = process.argv.slice(2);
        if (argv.includes('--version')) { console.log('2.1.0'); process.exit(0); }
        if (argv.join(' ') === 'auth status --json') {
          writeFileSync(${JSON.stringify(seenPath)}, JSON.stringify({
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
            ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
            ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
            CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
          }));
          console.log(JSON.stringify({ loggedIn: process.env.TEST_LOGGED_IN === '1' }));
          process.exit(0);
        }
        process.exit(2);
      `);
      const binary = await writeNodeFixtureLauncher(dir, 'claude', script);
      vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-secret');
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-token');
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ambient.example');

      const loggedIn = await probeAgentAuth('claude', {
        binary,
        authMode: 'oauth',
        configDir: join(dir, 'cfg'),
        env: { TEST_LOGGED_IN: '1' },
      });
      expect(loggedIn).toEqual({ kind: 'claude', authMode: 'oauth', available: true, version: '2.1.0', credentialState: 'configured' });
      expect(JSON.parse(await readFile(seenPath, 'utf8'))).toEqual({
        ANTHROPIC_API_KEY: null,
        ANTHROPIC_AUTH_TOKEN: null,
        ANTHROPIC_BASE_URL: null,
        CLAUDE_CONFIG_DIR: join(dir, 'cfg'),
      });

      const loggedOut = await probeAgentAuth('claude', { binary, authMode: 'oauth', env: { TEST_LOGGED_IN: '0' } });
      expect(loggedOut).toMatchObject({ kind: 'claude', available: true, credentialState: 'missing', reason: 'not-logged-in' });
    });

    it('probes codex login status with scrubbed env and native/isolated CODEX_HOME', async () => {
      const dir = await tempDir('probe-codex-');
      const seenPath = join(dir, 'seen.json');
      const script = join(dir, 'codex-probe.mjs');
      await writeFile(script, `
        import { writeFileSync } from 'node:fs';
        const argv = process.argv.slice(2);
        if (argv.includes('--version')) { console.log('codex 0.166.0'); process.exit(0); }
        if (argv.join(' ') === 'login status') {
          writeFileSync(${JSON.stringify(seenPath)}, JSON.stringify({
            OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
            OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? null,
            CODEX_HOME: process.env.CODEX_HOME ?? null,
          }));
          if (process.env.TEST_LOGGED_IN === '1') { console.log('Logged in using ChatGPT'); process.exit(0); }
          console.log('Not logged in');
          process.exit(1);
        }
        process.exit(2);
      `);
      const binary = await writeNodeFixtureLauncher(dir, 'codex', script);
      const customHome = join(dir, 'codex-home');
      vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
      vi.stubEnv('OPENAI_BASE_URL', 'https://ambient.openai.example');

      const ok = await probeAgentAuth('codex', { binary, authMode: 'oauth', codexHome: customHome, env: { TEST_LOGGED_IN: '1' } });
      expect(ok).toEqual({ kind: 'codex', authMode: 'oauth', available: true, version: 'codex 0.166.0', credentialState: 'configured' });
      expect(JSON.parse(await readFile(seenPath, 'utf8'))).toEqual({
        OPENAI_API_KEY: null,
        OPENAI_BASE_URL: null,
        CODEX_HOME: customHome,
      });

      const missing = await probeAgentAuth('codex', { binary, authMode: 'oauth', env: { TEST_LOGGED_IN: '0' } });
      expect(missing).toMatchObject({ kind: 'codex', available: true, credentialState: 'missing', reason: 'not-logged-in' });
      expect(JSON.parse(await readFile(seenPath, 'utf8')).CODEX_HOME).toBe(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
    });

    it('probes agy availability and OAuth login status (including models fallback)', async () => {
      const dir = await tempDir('probe-agy-');
      const script = join(dir, 'agy-probe.mjs');
      await writeFile(script, `
        const argv = process.argv.slice(2);
        if (argv.includes('--version')) { console.log('1.4.10'); process.exit(0); }
        if (argv.join(' ') === 'auth status') {
          if (process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_BASE_URL) process.exit(99);
          if (process.env.AGY_MODE === 'fallback-ok') {
            console.error('unknown command: auth');
            process.exit(2);
          }
          if (process.env.AGY_MODE === 'logged-out') {
            console.log('Not logged in');
            process.exit(1);
          }
          console.log('Logged in');
          process.exit(0);
        }
        if (argv.join(' ') === 'models') {
          console.log('gemini-2.5-flash  Gemini 2.5 Flash');
          process.exit(0);
        }
        process.exit(2);
      `);
      const binary = await writeNodeFixtureLauncher(dir, 'agy', script);
      vi.stubEnv('GEMINI_API_KEY', 'ambient-gemini');
      vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://ambient.gemini.example');

      expect(await probeAgentAuth('agy', { binary, authMode: 'oauth' })).toEqual({
        kind: 'agy', authMode: 'oauth', available: true, version: '1.4.10', credentialState: 'configured',
      });
      expect(await probeAgentAuth('agy', { binary, authMode: 'oauth', env: { AGY_MODE: 'fallback-ok' } })).toMatchObject({
        kind: 'agy', available: true, credentialState: 'configured',
      });
      expect(await probeAgentAuth('agy', { binary, authMode: 'oauth', env: { AGY_MODE: 'logged-out' } })).toMatchObject({
        kind: 'agy', available: true, credentialState: 'missing', reason: 'not-logged-in',
      });
      expect(await probeAgentAuth('agy', { binary, authMode: 'api_key', apiKey: 'explicit-k' })).toMatchObject({
        kind: 'agy', authMode: 'api_key', available: true, credentialState: 'configured',
      });
    });

    it('probes dsh config readiness', async () => {
      const dir = await tempDir('probe-dsh-');
      expect(await probeAgentAuth('dsh')).toMatchObject({
        kind: 'dsh', available: true, credentialState: 'missing', reason: 'not-configured',
      });
      expect(await probeAgentAuth('dsh', { apiKey: 'dsh-key', endpoint: 'https://api.deepseek.com' })).toEqual({
        kind: 'dsh', authMode: 'api_key', available: true, credentialState: 'configured',
      });
      expect(await probeAgentAuth('dsh', { apiKey: 'dsh-key', packageRoot: join(dir, 'missing-pkg') })).toMatchObject({
        kind: 'dsh', available: false, credentialState: 'missing', reason: 'harness-runtime-missing',
      });
    });
  });

  describe('dsh availability and workflow host-runner support', () => {
    it('resolves checkRuntimeAgentAvailability for dsh using registered backend specs', async () => {
      const unavailableDsh: AgentAdapter = {
        id: 'dsh',
        displayName: 'DeepSeek Harness',
        capabilities: { finalAnswer: 'separate-event', input: 'unsupported' },
        isAvailable: async () => false,
        prepareRun: async () => { throw new Error('unused'); },
      };
      const result = await checkRuntimeAgentAvailability(unavailableDsh);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostic.agentId).toBe('dsh');
        expect(result.diagnostic.command).toBe('dsh');
      }
    });

    it('allows dsh workers in createBridgeWorkflowRuntime when host supplies custom runner/policy', async () => {
      const dir = await tempDir('wf-dsh-');
      const root: WorkflowRoot = {
        scopeId: 'dsh-scope',
        profile: 'dsh',
        agentKind: 'dsh',
        cwdRealpath: dir,
        policyFingerprint: 'root-fp',
        catalogBinding: 'dsh-session-1',
        modelSettings: { model: 'deepseek-chat', reasoningEffort: 'off' },
      };
      const policy: RunPolicyAllow = {
        ok: true,
        prompt: '',
        requestedCwd: dir,
        cwdRealpath: dir,
        accessMode: 'full',
        sandbox: 'danger-full-access',
        permissionMode: 'bypassPermissions',
        access: { ok: true, reason: 'allowed-user' },
        attachments: [],
        policyFingerprint: 'root-fp',
        expiresAt: Date.now() + 60_000,
      };
      const executor = new RunExecutor({
        resolveAgent: () => { throw new Error('custom runner handles execution'); },
        pool: new ProcessPool(() => 2),
        activeRuns: new ActiveRuns(),
      });
      const customRunner: WorkerRunner = {
        start: vi.fn(async () => ({
          runId: 'run-1',
          result: Promise.resolve('completed' as const),
          stop: async () => {},
          waitForExit: async () => true,
          stopReason: () => undefined,
          async *events() {
            yield { type: 'final_text', text: 'ok' } as const;
            yield { type: 'done', normal: true } as const;
          },
        })),
      };
      const dshProfile = {
        ...createDefaultProfileConfig({
          agentKind: 'claude',
          accounts: { app: { id: 'test', secret: 'test', tenant: 'feishu' } },
          permissions: { defaultAccess: 'full', maxAccess: 'full' },
        }),
        agentKind: 'dsh' as const,
      };
      const runtime = createBridgeWorkflowRuntime({
        path: ':memory:',
        executor,
        runner: customRunner,
        resolve: async () => ({ root, policy }),
        resolveWorker: async (boundRoot, selection, rootPolicy) => resolveWorkerExecution(
          boundRoot,
          dshProfile,
          rootPolicy,
          { model: selection.model, reasoningEffort: selection.reasoningEffort },
        ),
        wakeMain: async () => {},
      });
      await runtime.start();
      try {
        const main = runtime.bindMain(root.scopeId, 'start');
        const { callWorkflow } = await import('@kuribohg/agent-workflows');
        const queued = await callWorkflow('run_script', {
          operationId: 'op-dsh-1',
          expectedStateVersion: runtime.kernel.state(root.scopeId)?.stateVersion,
          goal: 'test dsh worker',
          plan: 'Run a dsh worker through the custom runner.',
          execution: { agentKind: 'dsh', model: 'deepseek-chat', reasoningEffort: 'off' },
          script: 'return await agent("hello", { key: "w1" });',
        }, main.env) as { script: { status: string } };
        expect(queued.script.status).toBe('queued');
        await vi.waitFor(() => {
          expect(runtime.kernel.state(root.scopeId)?.script?.status).toBe('result_ready');
        }, { timeout: 10_000 });
        expect(customRunner.start).toHaveBeenCalledTimes(1);
      } finally {
        await runtime.close();
      }
    });
  });
});
