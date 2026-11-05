import { describe, expect, it } from 'vitest';
import {
  commandDefinitions,
  commandDefinitionsFor,
  commandHelpLines,
  findCommand,
  parseSlashCommand,
} from '../../../src/commands/catalog';

describe('shared slash command parser', () => {
  it('ignores text that does not start with a slash', () => {
    expect(parseSlashCommand('hello /status')).toBeUndefined();
    expect(parseSlashCommand('')).toBeUndefined();
    expect(parseSlashCommand('  ')).toBeUndefined();
  });

  it('resolves a bare command and reports its catalog entry', () => {
    expect(parseSlashCommand('/status')).toMatchObject({ name: 'status', args: '' });
    expect(parseSlashCommand('/status')?.definition?.name).toBe('status');
  });

  it('resolves aliases to the canonical definition', () => {
    expect(parseSlashCommand('/reset')).toMatchObject({ name: 'reset', args: '' });
    expect(parseSlashCommand('/reset')?.definition?.name).toBe('new');
  });

  it('collapses whitespace for word arguments', () => {
    expect(parseSlashCommand('/config   run   now')).toMatchObject({
      name: 'config',
      args: 'run now',
    });
  });

  it('preserves indentation and blank lines for verbatim commands', () => {
    expect(parseSlashCommand('/run   first\n\n  second')?.args).toBe('first\n\n  second');
    expect(parseSlashCommand('/btw   keep   spacing')?.args).toBe('keep   spacing');
  });

  it('only lowercases names when the channel asks for it', () => {
    expect(parseSlashCommand('/Status')).toMatchObject({ name: 'Status' });
    expect(parseSlashCommand('/Status')?.definition).toBeUndefined();
    expect(parseSlashCommand('/Status', findCommand, { caseInsensitive: true })).toMatchObject({
      name: 'status',
    });
    expect(parseSlashCommand('/Status', findCommand, { caseInsensitive: true })?.definition).toBeDefined();
  });

  it('keeps unknown slash commands parseable without a definition', () => {
    expect(parseSlashCommand('/unknown  some text')).toEqual({ name: 'unknown', args: 'some text' });
  });
});

describe('channel-scoped command catalog', () => {
  it('exposes only the commands Slack implements', () => {
    expect(commandDefinitionsFor('slack').map(definition => definition.name))
      .toEqual(['new', 'model', 'status', 'stop', 'help']);
  });

  it('keeps every Lark command in the default channel', () => {
    expect(commandDefinitionsFor('lark')).toHaveLength(commandDefinitions.length);
    expect(commandDefinitionsFor('lark').map(definition => definition.name)).toContain('config');
  });

  it('renders Slack help from channel-specific lines', () => {
    const lines = commandHelpLines('', commandDefinitionsFor('slack'), 'slack');
    expect(lines).toEqual([
      "- `/new` — forget this thread's native session",
      '- `/model` — show the current engine',
      '- `/status` — show engine and run state',
      '- `/stop` — stop the active run',
      '- `/help [command]` — list commands or show details for one',
    ]);
  });

  it('renders Lark help without leaking Slack-only lines', () => {
    const text = commandHelpLines('Agent').join('\n');
    expect(text).toContain('/config');
    expect(text).toContain('Agent');
    expect(text).not.toContain("forget this thread's native session");
  });
});
