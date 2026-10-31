import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { AgyStreamTranslator } from '../../../src/agent/agy/stream-json';
import { AgyAdapter } from '../../../src/agent/agy/adapter';
import { ModelProviderRegistry } from '../../../src/model-provider/provider';
import { normalizeModelServices } from '../../../src/model-service/config';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';

const binary = process.env.LARK_TEST_AGY_BINARY;
const configPath = process.env.LARK_TEST_AGY_PROVIDERS;
const workspace = process.env.LARK_TEST_AGY_WORKSPACE;
const selection = process.env.LARK_TEST_AGY_MODEL;
const rawEvents: unknown[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  if (process.env.LARK_TEST_AGY_OUTPUT) await writeFile(`${process.env.LARK_TEST_AGY_OUTPUT}.raw.json`, JSON.stringify(rawEvents, null, 2));
});

/** Opt-in: credentials are references in a private JSON file, never test data. */
it.skipIf(!binary || !configPath || !workspace || !selection)('runs tools and resumes a real Antigravity conversation through the selected provider', async () => {
  const translate = AgyStreamTranslator.prototype.translate;
  vi.spyOn(AgyStreamTranslator.prototype, 'translate').mockImplementation(function (this: AgyStreamTranslator, value: unknown) {
    rawEvents.push(value); return translate.call(this, value);
  });
  const services = normalizeModelServices(JSON.parse(await readFile(configPath!, 'utf8')));
  const provider = await new ModelProviderRegistry(services).resolve('agy', selection);
  expect(provider?.agy).toBeDefined();
  await mkdir(workspace!, { recursive: true });
  const adapter = new AgyAdapter({ binary, systemPrompt: 'Follow the test instructions exactly. Do not contact messaging services or modify files.' });
  const options = { runId: 'native-smoke', cwd: workspace!, sandbox: 'danger-full-access' as const,
    model: provider!.model, modelProvider: provider, reasoningEffort: 'low' as const,
    prompt: 'Use run_command to execute exactly: printf "bridge-agy-smoke-6241\\n". Then reply with the printed marker. Do not run other commands or read files.' };
  await adapter.prepareRun(options);
  const first = await collect((await adapter.prepareRun(options)).start());
  if (process.env.LARK_TEST_AGY_OUTPUT) await writeFile(process.env.LARK_TEST_AGY_OUTPUT, JSON.stringify(first, null, 2));
  expect(first.some(event => event.type === 'tool_use' && event.name === 'run_command')).toBe(true);
  expect(first.some(event => event.type === 'tool_result' && !event.isError && event.output.includes('bridge-agy-smoke-6241'))).toBe(true);
  expect(first.filter(event => event.type === 'final_text')).toEqual([
    expect.objectContaining({ content: expect.stringContaining('bridge-agy-smoke-6241') }),
  ]);
  const done = first.find(event => event.type === 'done');
  expect(done).toMatchObject({ terminationReason: 'normal' });
  const sessionId = done?.type === 'done' ? done.sessionId : undefined;
  expect(sessionId).toBeTruthy();
  const second = await collect((await adapter.prepareRun({ ...options, runId: 'native-resume', sessionId,
    prompt: 'What exact marker did the command print in the previous turn? Reply with that marker only. Do not use tools.' })).start());
  expect(second.filter(event => event.type === 'final_text')).toEqual([
    expect.objectContaining({ content: expect.stringContaining('bridge-agy-smoke-6241') }),
  ]);
  expect(second.find(event => event.type === 'done')).toMatchObject({ sessionId, terminationReason: 'normal' });
}, 200_000);

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const timer = setTimeout(() => { void run.stop(); }, 90_000);
  try {
    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (events.filter(item => item.type === 'tool_use').length > 5) await run.stop();
    }
    return events;
  } finally {
    clearTimeout(timer);
    if (!await run.waitForExit(2000)) await run.stop();
  }
}
