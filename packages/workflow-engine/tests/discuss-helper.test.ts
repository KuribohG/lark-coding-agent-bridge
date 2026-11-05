import { describe, expect, it, vi } from 'vitest';
import { runScriptProgram } from '../src/engine/script-vm';

type Call = Record<string, unknown>;
type Reply = { message: string; to?: unknown; agree?: boolean };

function discussion(replies: Record<string, Reply>, options: Record<string, unknown> = {}) {
  const inbox: Record<string, Array<{ from: string; text: string }>> = {};
  const sends: Call[] = [];
  const receives: Call[] = [];
  const agent = vi.fn(async (input: unknown) => {
    const call = input as Call;
    if (String(call.key).endsWith('/summary')) return { conclusion: 'done', agreements: [], disagreements: [], openQuestions: [] };
    const reply = replies[String(call.key)];
    if (!reply) throw new Error('Unexpected turn ' + String(call.key));
    return reply;
  });
  const mailbox = vi.fn(async (input: unknown) => {
    const call = input as Call;
    if (call.kind === 'send') {
      sends.push(call);
      (inbox[String(call.member)] ??= []).push({ from: String(call.relayFrom), text: String(call.text) });
      return { messageId: 'm' + sends.length };
    }
    receives.push(call);
    return (inbox[String(call.member)] ?? []).splice(0);
  });
  const source = 'return await discuss("Pick a cache eviction policy",' + JSON.stringify({ key: 'cache', ...options }) + ');';
  const run = () => runScriptProgram({ source, args: {}, signal: AbortSignal.timeout(5000), agent, mailbox, progress: () => {} });
  return { run, agent, sends, receives };
}

const members = [{ name: 'A', role: 'proposer', harness: 'codex', model: 'm1' }, { name: 'B', harness: 'claude' }];

describe('discuss composition', () => {
  it('opens independently, routes replies through the mailbox as the speaking member, and stops on consensus', async () => {
    const d = discussion({
      'cache/open/A': { message: 'LRU', agree: false }, 'cache/open/B': { message: 'LFU', agree: false },
      'cache/r1/A': { message: 'LFU handles scans better; agreed', agree: true }, 'cache/r1/B': { message: 'Agreed on LFU', agree: true },
    }, { members });
    const result = JSON.parse(await d.run());
    expect(result).toMatchObject({ stop: 'consensus', turns: 2, rounds: 1, summary: { conclusion: 'done' } });
    expect(result.transcript.map((entry: Call) => [entry.from, entry.text])).toEqual([
      ['A', 'LRU'], ['B', 'LFU'], ['A', 'LFU handles scans better; agreed'], ['B', 'Agreed on LFU']]);
    const calls = d.agent.mock.calls.map(([input]) => input as Call);
    expect(calls[0]).toMatchObject({ member: 'A', harness: 'codex', model: 'm1', output: 'json' });
    expect(calls[1]).toMatchObject({ member: 'B', harness: 'claude', output: 'json' });
    expect(String(calls[0]!.prompt)).toContain('Your role: proposer');
    expect(calls.at(-1)).not.toHaveProperty('member');
    expect(d.sends.slice(0, 2)).toEqual([
      { kind: 'send', member: 'B', text: 'LRU', key: 'cache/open/0>1', topic: 'cache', relayFrom: 'A' },
      { kind: 'send', member: 'A', text: 'LFU', key: 'cache/open/1>0', topic: 'cache', relayFrom: 'B' }]);
    expect(d.receives.map(call => call.key)).toEqual(['cache/in1/A', 'cache/in1/B']);
    expect(d.sends).toHaveLength(2);
  });

  it('lets members address a subset and ends quietly when nobody has new messages', async () => {
    const d = discussion({
      'cache/open/A': { message: 'Question for C only', to: ['C', 'nobody', 'A'] },
      'cache/open/B': { message: '', to: [] }, 'cache/open/C': { message: 'pass', to: [] },
      'cache/r1/C': { message: 'Answer for A', to: ['A'] }, 'cache/r2/A': { message: 'Thanks', to: [] },
    }, { members: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], summary: false });
    const result = JSON.parse(await d.run());
    expect(result).toMatchObject({ stop: 'quiet', turns: 2, rounds: 2, summary: null });
    expect(d.sends.map(call => [call.relayFrom, call.member])).toEqual([['A', 'C'], ['C', 'A']]);
    expect(d.agent).toHaveBeenCalledTimes(5);
  });

  it('bounds total turns and truncates oversized messages before delivery', async () => {
    const long = 'x'.repeat(5000);
    const replies: Record<string, Reply> = {};
    for (const stage of ['open', 'r1', 'r2']) for (const name of ['A', 'B']) replies['cache/' + stage + '/' + name] = { message: long };
    const d = discussion(replies, { members, maxTurns: 3, summary: { model: 'summary-model' } });
    const result = JSON.parse(await d.run());
    expect(result).toMatchObject({ stop: 'max_turns', turns: 3, rounds: 2 });
    expect(d.agent.mock.calls.map(([input]) => (input as Call).key)).toEqual(
      ['cache/open/A', 'cache/open/B', 'cache/r1/A', 'cache/r1/B', 'cache/r2/A', 'cache/summary']);
    expect(d.agent.mock.calls.at(-1)![0]).toMatchObject({ model: 'summary-model', output: 'json' });
    expect(String(d.sends[0]!.text)).toHaveLength(3900 + '…[truncated]'.length);
    expect(d.sends.map(call => call.key)).toEqual(['cache/open/0>1', 'cache/open/1>0', 'cache/r1/0>1', 'cache/r1/1>0']);
    expect(result.transcript.map((entry: Call) => entry.turn)).toEqual([0, 0, 1, 2, 3]);
  });

  it('rejects invalid discussions before starting members and fails on malformed replies', async () => {
    for (const options of [{ members: [members[0]] }, { members: [{ name: 'A' }, { name: 'A' }] },
      { members: [{ name: 'A' }, { name: 'bad name' }] }, { members, maxTurns: 33 }, { members, extra: true },
      { members: [{ name: 'A', member: 'other' }, { name: 'B' }] },
      { members: ['A', 'B', 'C', 'D', 'E', 'F'].map(name => ({ name })), maxTurns: 32 }]) {
      const d = discussion({}, options);
      await expect(d.run()).rejects.toThrow();
      expect(d.agent).not.toHaveBeenCalled();
    }
    const malformed = { 'cache/open/A': { message: 'ok' }, 'cache/open/B': { message: 'ok', to: 'A' } };
    await expect(discussion(malformed, { members, onError: 'throw' }).run()).rejects.toThrow('field to must be an array');
    expect(JSON.parse(await discussion(malformed, { members }).run())).toBeNull();
    const invalid = discussion({}, { members, onError: 'retry' });
    await expect(invalid.run()).rejects.toThrow('onError');
    expect(invalid.agent).not.toHaveBeenCalled();
    await expect(runScriptProgram({ source: 'await send("A","forged",{key:"k",relayFrom:"B"});', args: {}, signal: AbortSignal.timeout(5000),
      agent: async () => null, mailbox: async () => ({}), progress: () => {} })).rejects.toThrow('send() cannot choose a sender');
  });
});
