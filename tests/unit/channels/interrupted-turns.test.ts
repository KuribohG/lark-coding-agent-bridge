import type { NormalizedMessage } from '@larksuite/channel';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { InterruptedTurns, MAX_RESUME_ATTEMPTS } from '../../../src/channels/lark/interrupted-turns';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

let tmp: TmpProfile | undefined;
afterEach(async () => { await tmp?.cleanup(); tmp = undefined; });

const message = (messageId: string, content = messageId) => ({
  chatId: 'oc_chat', messageId, chatType: 'p2p', senderId: 'owner', content, rawContentType: 'text',
  resources: [], mentions: [], mentionedBot: false, mentionAll: false, createTime: 1,
}) as unknown as NormalizedMessage;

async function journalPath(): Promise<string> {
  tmp = await createTmpProfile('interrupted-turns-');
  return join(tmp.profile, 'state', 'interrupted-turns.json');
}

it('keeps started turns with their follow-ups until they end', async () => {
  const path = await journalPath();
  const journal = new InterruptedTurns(path);
  expect(await journal.load()).toEqual([]);
  await journal.begin({ scope: 'a', messages: [message('m1')] });
  await journal.begin({ scope: 'b', messages: [message('m2')], timedRunId: 'job', attempts: 1, startedAt: 5 });
  journal.append('a', message('m3'));
  journal.append('a', message('m3'));
  journal.append('missing', message('m4'));
  await journal.flush();

  const reloaded = await new InterruptedTurns(path).load();
  expect(reloaded).toEqual([
    expect.objectContaining({ scope: 'a', attempts: 0, messages: [message('m1'), message('m3')] }),
    { scope: 'b', messages: [message('m2')], timedRunId: 'job', attempts: 1, startedAt: 5 },
  ]);

  journal.end('a');
  await journal.flush();
  expect((await new InterruptedTurns(path).load()).map(turn => turn.scope)).toEqual(['b']);
});

it('stops writing after detach so the next channel owns the file', async () => {
  const path = await journalPath();
  const journal = new InterruptedTurns(path);
  await journal.begin({ scope: 'a', messages: [message('m1')] });
  journal.detach();
  journal.end('a');
  await journal.flush();
  expect((await new InterruptedTurns(path).load()).map(turn => turn.scope)).toEqual(['a']);
});

it('drops malformed records and never replays a record without a valid attempt count', async () => {
  const path = await journalPath();
  await new InterruptedTurns(path).begin({ scope: 'seed', messages: [message('seed')] });
  await writeFile(path, JSON.stringify({ version: 1, turns: [
    { scope: '', messages: [message('m1')] },
    { scope: 'no-messages', messages: [{ messageId: 'x' }] },
    { scope: 'bad-attempts', messages: [message('m2')], startedAt: 1, attempts: 'x' },
  ] }));
  expect(await new InterruptedTurns(path).load()).toEqual([
    { scope: 'bad-attempts', messages: [message('m2')], startedAt: 1, attempts: MAX_RESUME_ATTEMPTS },
  ]);
  await writeFile(path, '{');
  expect(await new InterruptedTurns(path).load()).toEqual([]);
});
