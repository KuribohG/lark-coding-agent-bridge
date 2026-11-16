import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiSdkAdapter } from '../../src/agent/pi-sdk/adapter';
import { localWorkflowEndpoint, remoteHostSpawn, remoteRunEnv } from '../../src/agent/pi-sdk/remote';
import type { AgentEvent } from '../../src/agent/types';
import type { PiConfig } from '../../src/agent/pi/config';

// A remote host is spawned over ssh; the protocol is unchanged because it is
// plain JSONL on stdin/stdout. The fake ssh runs the script locally, which is
// equivalent when both machines see the same filesystem.

vi.mock('../../src/agent/preflight', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/agent/preflight')>(),
  checkAgentAvailability: vi.fn(async () => ({ ok: true as const, version: 'v22.23.3' })),
}));

const fakeHost = fileURLToPath(new URL('../fixtures/pi-sdk/fake-host.mjs', import.meta.url));
const fakeSsh = fileURLToPath(new URL('../fixtures/pi-sdk/fake-ssh.mjs', import.meta.url));
const adapters: PiSdkAdapter[] = [];
const dirs: string[] = [];
// Keep the SSH executable local and deterministic on every host. The real pipes, command and protocol are exercised.
vi.mock('../../src/platform/spawn', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/platform/spawn')>();
  return { ...actual, spawnProcess: (...input: Parameters<typeof actual.spawnProcess>) =>
    input[0] === 'ssh' ? actual.spawnProcess(process.execPath, [fakeSsh, ...(input[1] ?? [])], input[2]) : actual.spawnProcess(...input) };
});

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.shutdown();
  delete process.env.FAKE_HOST_RECORD;
  delete process.env.FAKE_SSH_RECORD;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

async function harness(env: Record<string, string> = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-sdk-remote-')));
  dirs.push(dir);
  const recordPath = join(dir, 'host-record.json');
  Object.assign(process.env, { FAKE_HOST_RECORD: recordPath, FAKE_SSH_RECORD: join(dir, 'ssh-record') }, env);
  await writeFile(join(dir, 'host-events.json'), '[]');
  process.env.FAKE_HOST_EVENTS = JSON.stringify([
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'OK' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } } } },
  ]);
  const config: PiConfig = {
    binaryPath: join(dir, 'pi'),
    transport: 'sdk',
    sdkPath: fakeHost,
    nodePath: process.execPath,
    hostScript: fakeHost,
    agentDir: join(dir, 'agent'),
    remote: 'fake-node',
  };
  const adapter = new PiSdkAdapter({ config, systemPrompt: 'REMOTE', profileStateDir: dir, stopGraceMs: 1000 });
  adapters.push(adapter);
  return {
    dir,
    adapter,
    recordPath,
    async sshRecords(): Promise<Array<{ mode: string; argv: string[]; destination?: string; script?: string }>> {
      const files = (await readdir(dir)).filter((name) => name.startsWith('ssh-record'));
      return Promise.all(files.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8'))));
    },
    async hostCalls(): Promise<Array<{ cmd: string; params: Record<string, unknown> }>> {
      return JSON.parse(await readFile(recordPath, 'utf8')).calls;
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe('pi SDK remote host', () => {
  it('runs the host through ssh with the environment delivered by a private file', async () => {
    const h = await harness();
    const events = await collect((await h.adapter.prepareRun({
      runId: 'remote-run',
      prompt: 'go',
      cwd: h.dir,
      env: { PI_REMOTE_MARKER: 'from-env-file' },
    })).start().events);

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.find((event) => event.type === 'final_text')).toEqual({ type: 'final_text', content: 'OK' });
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });

    const [exec] = (await h.sshRecords()).filter((record) => record.mode === 'exec');
    expect(exec?.destination).toBe('fake-node');
    expect(exec?.argv).toEqual(expect.arrayContaining(['-o', 'BatchMode=yes']));
    // The remote script sources the env file, then execs the host directly.
    expect(exec?.script).toContain(`. '${join(h.dir, 'remote-env')}${sep}`);
    expect(exec?.script).toContain('rm -f');
    expect(exec?.script).toContain(`exec '${process.execPath}' '${fakeHost}'`);
    expect(exec?.script).toContain('--agent-dir');
    // The run binding reached the host itself (it records what it was told).
    const calls = await h.hostCalls();
    expect(calls[0]?.params).toMatchObject({ runEnv: { PI_REMOTE_MARKER: 'from-env-file' } });
    // The remote shell removes the environment file as soon as it sourced it.
    await vi.waitFor(async () => {
      const left = (await readdir(join(h.dir, 'remote-env')).catch(() => [])).length;
      expect(left).toBe(0);
    });
  }, 30_000);

  it('publishes the workflow endpoint through a reverse tunnel for the remote run', async () => {
    const h = await harness();
    const localEndpoint = 'http://127.0.0.1:43210/workflow';
    const events = await collect((await h.adapter.prepareRun({
      runId: 'remote-workflow',
      prompt: 'go',
      cwd: h.dir,
      env: { AGENT_WORKFLOW_TOKEN: 'token', AGENT_WORKFLOW_ENDPOINT: localEndpoint, AGENT_WORKFLOW_CLI: '/pkg/dist/workflow-cli.js' },
    })).start().events);

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    const records = await h.sshRecords();
    const tunnel = records.find((record) => record.mode === 'tunnel');
    expect(tunnel?.argv).toEqual(expect.arrayContaining(['-N', '-o', 'ExitOnForwardFailure=yes']));
    const forward = tunnel?.argv[tunnel.argv.indexOf('-R') + 1];
    expect(forward).toMatch(/^127\.0\.0\.1:\d+:127\.0\.0\.1:43210$/);
    const remotePort = forward!.split(':')[1];

    // The host receives the tunnel endpoint, never the bridge's own port or the
    // local-only endpoint file.
    const calls = await h.hostCalls();
    const runEnv = calls[0]?.params.runEnv as Record<string, string>;
    expect(runEnv.AGENT_WORKFLOW_ENDPOINT).toBe(`http://127.0.0.1:${remotePort}/workflow`);
    expect(runEnv.AGENT_WORKFLOW_ENDPOINT_FILE).toBeUndefined();
    expect(runEnv.AGENT_WORKFLOW_TOKEN).toBe('token');

    await h.adapter.shutdown();
    expect(adapters.length).toBe(1);
  }, 30_000);
});

describe('remote host command line', () => {
  it('quotes the environment values and the exec arguments exactly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-remote-unit-'));
    dirs.push(dir);
    const spawn = remoteHostSpawn({
      destination: 'user@node01',
      ssh: 'ssh',
      sshOptions: ['-i', '/keys/id'],
      stateDir: dir,
    }, {
      nodePath: '/weka/node/bin/node',
      hostScript: '/weka/bridge/bin/pi-host.mjs',
      args: ['--sdk', "/weka/pi/it's here/index.js"],
      cwd: '/weka/work dir',
      env: { TOKEN: "it's secret" },
    });

    expect(spawn.command).toBe('ssh');
    expect(spawn.args.slice(-2, -1)).toEqual(['user@node01']);
    const script = spawn.args.at(-1)!;
    expect(script).toContain(`cd '/weka/work dir'`);
    expect(script).toContain(`exec '/weka/node/bin/node' '/weka/bridge/bin/pi-host.mjs' '--sdk'`);
    expect(script).toContain(`'/weka/pi/it'\\''s here/index.js'`);

    const env = readFileSync(spawn.envFile, 'utf8');
    expect(env).toContain(`export TOKEN='it'\\''s secret'`);
    if (process.platform === 'win32') {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$acl = [IO.File]::GetAccessControl($env:TEST_PRIVATE_FILE)',
        '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        '$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])',
        '[bool]($acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and !$rules[0].IsInherited' +
          ' -and $rules[0].IdentityReference.Value -eq $sid -and $rules[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow' +
          ' -and $rules[0].FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl)',
      ].join('; ');
      const verified = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, TEST_PRIVATE_FILE: spawn.envFile }, encoding: 'utf8', windowsHide: true,
      });
      expect(verified.trim()).toBe('True');
    } else {
      expect(statSync(spawn.envFile).mode & 0o777).toBe(0o600);
    }
    spawn.cleanup();
    expect(existsSync(spawn.envFile)).toBe(false);
  });

  it('rejects a destination that would be parsed as an ssh option', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-remote-unit-'));
    dirs.push(dir);
    expect(() => remoteHostSpawn({ destination: '-oProxyCommand=x', stateDir: dir }, {
      nodePath: 'node', hostScript: 'host.mjs', args: [], env: {},
    })).toThrow(/invalid ssh destination/);
  });

  it('resolves the published endpoint file before rewriting the run environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-remote-unit-'));
    dirs.push(dir);
    const file = join(dir, 'workflows.sqlite.endpoint.json');
    writeFileSync(file, JSON.stringify({ endpoint: 'http://127.0.0.1:5555/workflow' }));

    expect(localWorkflowEndpoint({ AGENT_WORKFLOW_ENDPOINT_FILE: file })).toBe('http://127.0.0.1:5555/workflow');
    expect(localWorkflowEndpoint({ AGENT_WORKFLOW_ENDPOINT: 'http://127.0.0.1:1/workflow' })).toBe('http://127.0.0.1:1/workflow');
    expect(localWorkflowEndpoint({})).toBeUndefined();

    expect(remoteRunEnv({ AGENT_WORKFLOW_ENDPOINT_FILE: file, AGENT_WORKFLOW_TOKEN: 't' }, 'http://127.0.0.1:9/workflow'))
      .toEqual({ AGENT_WORKFLOW_TOKEN: 't', AGENT_WORKFLOW_ENDPOINT: 'http://127.0.0.1:9/workflow' });
  });
});

