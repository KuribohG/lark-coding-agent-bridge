import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { prepareManagedCodexConfig } from '../../src/agent/codex/managed-config';
import { expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import type { AgentEvent } from '../../src/agent/types';

// An actual Codex runtime and shell, driven by a deterministic local Responses
// fixture. No model service, account credentials, or shared daemon is used.
it.skipIf(!process.env.BRIDGE_CODEX_NATIVE_BINARY || process.platform === 'win32').each(['per-run', 'daemon'] as const)('applies tool context in native %s shells across start, resume and fork', async mode => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-env-'));
  const home = join(dir, 'home');
  const cwd = join(dir, 'workspace');
  await Promise.all([mkdir(home), mkdir(cwd)]);
  const profile = { LARK_CHANNEL: '1', LARK_CHANNEL_HOME: join(dir, 'channel'), LARK_CHANNEL_PROFILE: 'fixture-profile',
    LARK_CHANNEL_CONFIG: join(dir, 'lark.config'), LARKSUITE_CLI_CONFIG_DIR: join(dir, 'lark-cli') };
  const probe = join(cwd, 'probe.mjs');
  await writeFile(probe, `console.log(JSON.stringify({...Object.fromEntries(${JSON.stringify(Object.keys(profile))}.map(key=>[key,process.env[key]??null])),token:process.env.LARK_WORKFLOW_TOKEN??null,endpoint:process.env.LARK_WORKFLOW_ENDPOINT??null}));\n`);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}`;
  let calls = 0;
  const outputs: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const tools = (body.tools ?? []).flatMap((tool: any) => tool.type === 'namespace' ? tool.tools : [tool]);
    const exec = tools.find((tool: any) => ['exec_command', 'shell_command', 'shell'].includes(tool.name));
    if (!exec) { response.writeHead(400); response.end(JSON.stringify({ error: { message: `Missing shell tool: ${tools.map((t: any) => t.name).join(',')}` } })); return; }
    const input = body.input ?? [];
    const userIndex = input.findLastIndex((item: any) => item.role === 'user');
    const result = input.slice(userIndex + 1).filter((item: any) => item.type === 'function_call_output').at(-1);
    if (result) outputs.push(typeof result.output === 'string' ? result.output : JSON.stringify(result.output));
    const item = result
      ? { type: 'message', id: `answer-${calls}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'probe complete' }] }
      : { type: 'function_call', id: `tool-${calls}`, call_id: `call-${calls}`, name: exec.name,
        arguments: JSON.stringify(exec.name === 'exec_command' ? { cmd: command, max_output_tokens: 1000 }
          : exec.name === 'shell_command' ? { command, timeout_ms: 10000 }
          : { command: [process.execPath, probe], timeout_ms: 10000 }), status: 'completed' };
    const id = `response-${calls++}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('response.created', { response: { id, status: 'in_progress', output: [] } });
    send('response.output_item.added', { output_index: 0, item });
    send('response.output_item.done', { output_index: 0, item });
    send('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const provider = { id: 'fixture', displayName: 'Fixture', model: 'gpt-5.1-codex', env: { FIXTURE_KEY: 'fixture-key' },
    codex: { providerId: 'fixture', name: 'Fixture', baseUrl: `http://127.0.0.1:${port}/v1`, wireApi: 'responses' as const, apiKeyEnv: 'FIXTURE_KEY' } };
  let daemon: ChildProcess | undefined;
  let daemonExit: Promise<void> | undefined;
  let binary = process.env.BRIDGE_CODEX_NATIVE_BINARY!;
  let run: ReturnType<Awaited<ReturnType<CodexAdapter['prepareRun']>>['start']> | undefined;
  try {
    if (mode === 'daemon') {
      // Start the real server without any profile/attempt bindings, before the
      // adapter connects. The lifecycle shim exposes this existing instance.
      const config = await prepareManagedCodexConfig(home, provider);
      await config.commit?.();
      const socket = join(dir, 'app.sock');
      daemon = spawn(binary, ['app-server', '--listen', `unix://${socket}`], {
        cwd, env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: home, FIXTURE_KEY: 'fixture-key' },
        stdio: 'ignore',
      });
      daemonExit = new Promise(resolve => daemon!.once('exit', () => resolve()));
      await expect.poll(async () => stat(socket).then(() => true, () => false), { timeout: 5000 }).toBe(true);
      const shim = join(dir, 'codex.cjs');
      await writeFile(shim, `#!${process.execPath}\nconst cp=require('node:child_process');const args=process.argv.slice(2);\n`
        + `if(args[0]==='app-server'&&args[1]==='daemon'){if(args[2]!=='version')process.exit(2);console.log(JSON.stringify({status:'running',apiVersion:1,socketPath:${JSON.stringify(socket)}}));}\n`
        + `else {const child=cp.spawn(${JSON.stringify(binary)},args,{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));}\n`);
      await chmod(shim, 0o700);
      binary = shim;
    }
    const adapter = new CodexAdapter({ binary, profileStateDir: dir,
      codexHome: home, appServerMode: mode, env: profile, startupProvider: async () => provider });
    let threadId: string | undefined;
    const turns = [
      { token: 'attempt-one', endpoint: 'old-endpoint', fork: false },
      { token: 'attempt-two', endpoint: undefined, fork: false },
      { token: 'attempt-three', endpoint: undefined, fork: true },
    ];
    for (const [index, turn] of turns.entries()) {
      run = (await adapter.prepareRun({ runId: `native-env-${index}`, cwd, prompt: `Run environment probe ${index}.`,
        model: provider.model, ...(threadId ? { threadId, forkSession: turn.fork } : {}),
        env: { LARK_WORKFLOW_TOKEN: turn.token, ...(turn.endpoint ? { LARK_WORKFLOW_ENDPOINT: turn.endpoint } : {}) },
        deadlineAt: Date.now() + 20_000 })).start();
      const events: AgentEvent[] = [];
      for await (const event of run.events) {
        events.push(event);
        if (event.type === 'system') threadId = event.threadId ?? threadId;
      }
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      for (const [key, value] of Object.entries(profile)) expect(outputs.at(-1)).toContain(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
      expect(outputs.at(-1)).toContain(`"token":"${turn.token}"`);
      expect(outputs.at(-1)).toContain(`"endpoint":${JSON.stringify(turn.endpoint ?? null)}`);
      expect(events).toContainEqual(expect.objectContaining({ type: 'done', terminationReason: 'normal' }));
      expect(await run.waitForExit(2000)).toBe(true);
    }
  } finally {
    await run?.stop();
    await run?.waitForExit(2000);
    daemon?.kill();
    await daemonExit;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 75_000);
