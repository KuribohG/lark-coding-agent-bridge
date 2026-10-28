import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  tryHandleCommand,
  runCommandHandler,
  CommandRegistry,
  type CommandContext,
} from '../../../src/commands';
import { handleRun } from '../../../src/commands/run';
import { helpCard } from '../../../src/card/templates';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

vi.mock('../../../src/commands/run', () => ({ handleRun: vi.fn(async () => {}) }));

function context(content: string): CommandContext {
  return {
    msg: { content, senderId: 'ou_visitor', chatId: 'oc_chat', messageId: 'om_input' },
    channel: { send: vi.fn(async () => ({ messageId: 'om_reply' })) },
    chatMode: 'group', scope: 'oc_chat:omt_topic',
    controls: {
      profileConfig: createDefaultProfileConfig({ agentKind: 'claude', accounts: {
        app: { id: 'test', secret: '${TEST_SECRET}', tenant: 'feishu' },
      } }),
      botOwnerId: 'ou_owner', ownerRefreshState: 'ok',
      btw: { enqueue: vi.fn(async () => {}) },
    },
  } as unknown as CommandContext;
}

beforeEach(() => vi.clearAllMocks());

describe('command dispatch contract', () => {
  it.each(['account', 'config', 'ps', 'exit', 'reconnect', 'doctor', 'cd', 'ws', 'invite', 'remove', 'meeting'])(
    'denies non-admin %s from both messages and buttons before entering its handler', async name => {
      const ctx = context(`/${name}`);
      await expect(tryHandleCommand(ctx)).resolves.toBe(true);
      expect(ctx.channel.send).toHaveBeenCalledOnce();
      expect(JSON.stringify(vi.mocked(ctx.channel.send).mock.calls)).toContain('仅管理员可用');
      await expect(runCommandHandler(name, '', { ...ctx, fromCardAction: true })).resolves.toBe(true);
      expect(ctx.channel.send).toHaveBeenCalledOnce();
    },
  );

  it.each(['run', 'btw'])('preserves paragraphs and indentation in /%s', async name => {
    const task = 'first paragraph\n\n  indented command';
    const ctx = context(`/${name}   ${task}`);
    await expect(tryHandleCommand(ctx)).resolves.toBe(true);
    const handler = name === 'run' ? handleRun : ctx.controls.btw!.enqueue;
    expect(handler).toHaveBeenCalledWith(task, ctx);
    await runCommandHandler(name, task, ctx);
    expect(handler).toHaveBeenLastCalledWith(task, ctx);
  });

  it('keeps unknown commands available for agent input', async () => {
    const ctx = context('/unknown some text');
    expect(await tryHandleCommand(ctx)).toBe(false);
    expect(await runCommandHandler('unknown', '', ctx)).toBe(false);
    expect(ctx.channel.send).not.toHaveBeenCalled();
  });

  it('resolves the reset alias to the scoped new-session handler', async () => {
    const ctx = context('/reset');
    ctx.sessions = { clear: vi.fn() } as unknown as CommandContext['sessions'];
    ctx.activeRuns = { interrupt: vi.fn(() => false) } as unknown as CommandContext['activeRuns'];
    ctx.controls.btw = undefined;
    await expect(tryHandleCommand(ctx)).resolves.toBe(true);
    expect(ctx.sessions.clear).toHaveBeenCalledWith('oc_chat:omt_topic');
    expect(ctx.activeRuns.interrupt).toHaveBeenCalledWith('oc_chat:omt_topic');
  });

  it('includes assistant, meeting and access commands in help', () => {
    const commands = new CommandRegistry([{
      pluginId: 'work-items',
      definition: {
        name: 'inbox',
        access: 'user',
        pending: 'preserve',
        arguments: 'words',
        help: ['`/inbox` — 查看和处理会话助理事项'],
      },
      handler: async () => {},
    }]);
    const text = JSON.stringify(helpCard('Agent', commands.helpLines('Agent')));
    for (const name of ['inbox', 'meeting', 'invite', 'remove', 'reset']) expect(text).toContain(`/${name}`);
  });
});
