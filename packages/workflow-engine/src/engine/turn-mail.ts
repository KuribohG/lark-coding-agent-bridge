import { memberName } from './board';
import { taskById } from './kernel-state';
import { emit } from './kernel-store';
import { TURN_MAIL_BATCH, TURN_MAIL_PER_TURN, TURN_MAIL_TEXT } from './limits';
import { memberSwarm, readsPosts } from './swarm';
import type { BoardPost, Immutable, MailboxMessage, WorkflowView } from './types';

/**
 * Asks and answers for a swarm member that is in a turn.
 *
 * Whoever asks waits for the answer, and whoever is answered goes on with it, yet a post reaches a member in its
 * messages at its next turn, which for a member that is working is when its task is done. Where the member's harness
 * takes input while a turn runs, an ask made of it and the answer to an ask of its own enter that turn instead, the
 * way tell_worker puts the words of a lead into it. Notes and rulings stay out of running turns: nobody waits on them.
 *
 * What entered a turn is input of that turn (`turn_mail_shown`): it wakes the member for no turn of its own, a retry
 * of the turn is handed it again, and the turn consumes it when it completes. The host says that the harness accepted
 * the words, not that the model read them, so nothing depends on it alone: an ask stays a to-do of the member until it
 * is answered, and the member's next brief names the answers its turn was shown.
 */

/** What to put into one running turn: the messages it stands for, as one text. */
export interface TurnMail { taskId: string; messageIds: string[]; text: string }

type Post = Immutable<BoardPost>;

/** The post a message delivers while the board still holds it; one that has left for the archive is urgent to nobody. */
function post(state: WorkflowView, message: Immutable<MailboxMessage>): Post | undefined {
  return message.post === undefined ? undefined : state.board?.posts[message.post - (state.archivedRecords?.post ?? 0) - 1];
}

const author = (state: WorkflowView, from: Post) => from.from ? memberName(state, from.from) : 'the main agent';

function render(state: WorkflowView, posts: Post[]): string {
  const asks = posts.filter(item => item.ask).length, answers = posts.length - asks;
  const quote = (item: Post) => item.text.length > TURN_MAIL_TEXT ? item.text.slice(0, TURN_MAIL_TEXT) + `…[read_board({after: ${item.seq - 1}, limit: 1, resolved: true}) has the rest]` : item.text;
  return posts.map(item => (item.ask ? `[Ask ${item.seq} from ${author(state, item)}, which waits ${Math.max(1, Math.round(item.ask.within / 60_000))} min]`
    : `[Answer to your ask ${item.answers} from ${author(state, item)}]`) + '\n' + quote(item)).join('\n\n')
    + '\n\n(' + [`${posts.length > 1 ? 'These reached' : 'This reached'} you on the board of the workflow while you work; ${posts.length > 1 ? 'they are' : 'it is'} not a new task.`,
      ...(asks ? [`${asks > 1 ? 'Each ask' : 'The ask'} is a to-do of yours until it is answered: answer({ask, text}) now when a few lines will do, else once the step you are in is done; when you cannot answer yet, answer with what it waits on.`] : []),
      ...(answers ? [`${answers > 1 ? 'Each answer' : 'The answer'} closed the ask it names.`] : []),
      'Then go on with the task you have.'].join(' ') + ')';
}

/**
 * What to put into which running turns now: for each swarm member in a turn, the oldest asks still open and answers
 * that wait in its messages, as far as the turn has room for them. `waits` names the turns that take nothing now.
 */
export function turnMail(state: WorkflowView, waits: (taskId: string) => boolean): TurnMail[] {
  if (!state.mailbox?.messages.length) return [];
  const turns = new Map<string, { taskId: string; room: number; mail: Array<{ id: string; post: Post }> }>();
  for (const agent of state.agents ?? []) {
    const taskId = agent.activeTurnId;
    if (!taskId || waits(taskId) || taskById(state, taskId)?.status !== 'running' || !memberSwarm(state, agent.key) || !readsPosts(state, agent.key)) continue;
    turns.set(agent.agentId, { taskId, room: TURN_MAIL_PER_TURN, mail: [] });
  }
  if (!turns.size) return [];
  for (const message of state.mailbox.messages) {
    const turn = turns.get(message.to);
    if (!turn) continue;
    if (message.shownInTurnId === turn.taskId) { turn.room--; continue; }
    if (message.receiptId || message.consumedByTurnId || message.shownInTurnId) continue;
    const delivered = post(state, message);
    if (delivered && (delivered.ask ? !delivered.resolved : delivered.answers !== undefined)) turn.mail.push({ id: message.id, post: delivered });
  }
  return [...turns.values()].flatMap(turn => {
    const mail = turn.mail.slice(0, Math.max(0, Math.min(TURN_MAIL_BATCH, turn.room)));
    return mail.length ? [{ taskId: turn.taskId, messageIds: mail.map(item => item.id), text: render(state, mail.map(item => item.post)) }] : [];
  });
}

/**
 * Records that a turn was shown messages, once the host has accepted them. A turn that ended meanwhile, or messages
 * that something else has taken since, are left as they are: the member reads them at its next turn, a second time.
 */
export function showTurnMail(state: WorkflowView, taskId: string, messageIds: readonly string[]): void {
  const agent = state.agents?.find(item => item.activeTurnId === taskId);
  if (!agent || taskById(state, taskId)?.status !== 'running') return;
  const shown = (state.mailbox?.messages ?? []).filter(message => messageIds.includes(message.id) && message.to === agent.agentId
    && !message.receiptId && !message.consumedByTurnId && !message.shownInTurnId).map(message => message.id);
  if (shown.length) emit(state, { type: 'turn_mail_shown', taskId, messageIds: shown });
}

/** The answers a turn was shown while it ran, for the brief of the member's next turn. */
export function answersShown(state: WorkflowView, taskId: string | undefined): Array<{ ask: number; post: number; from: string }> {
  if (!taskId) return [];
  return (state.mailbox?.messages ?? []).flatMap(message => {
    const delivered = message.shownInTurnId === taskId ? post(state, message) : undefined;
    return delivered?.answers === undefined ? [] : [{ ask: delivered.answers, post: delivered.seq, from: author(state, delivered) }];
  });
}
