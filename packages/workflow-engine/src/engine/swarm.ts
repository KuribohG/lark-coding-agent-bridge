import { randomUUID } from 'node:crypto';
import { postToBoard, readBoard } from './board';
import { workflowDigest } from './digest';
import { availableMessages, receiveMessages, scheduleMemberTurn } from './durable-agents';
import type { DomainEvent } from './events';
import { boardTotal, callCount, pushEvent, readArtifact, taskById } from './kernel-state';
import { emit, readText } from './kernel-store';
import type { KernelContext } from './kernel-context';
import { BOARD_ANNOUNCE_TOPIC, BOARD_HANDOFF_TOPIC, MAX_CONCURRENT_WORKERS, SWARM_DECLARED_MEMBERS, SWARM_MAX_MEMBERS, SWARM_MAX_TURNS } from './limits';
import { workerSelection } from './execution';
import { boundedInteger, parseScriptAgentCall, scriptText } from './script-contract';
import { WAKE_MAX_MINUTES } from './steering';
import { availableWork, openQueue, unfinishedWork, workFlow, workItem, workStatus, type WorkAuthority } from './work-queue';
import { queueControl, queueName } from './work-routing';
import type { Immutable, NativeIdKind, SwarmMember, WorkerExecution, WorkerExecutionPolicy, WorkerExecutionSelection, WorkflowSwarm, WorkflowTask, WorkflowView, WorkflowWorkItem } from './types';

const BUSY = new Set<WorkflowTask['status']>(['queued', 'starting', 'running', 'cancelling', 'waiting_workflow']);
const NAME = /^[A-Za-z0-9_.-]{1,40}$/;
const RESERVED = ['all', 'main', 'script', 'system'];
/** How often an idle swarm reminds its lead to assign work or finish before the main agent is told that it has stalled. */
const MAX_NUDGES = 2;
/**
 * While other members are working, posts to the lead are gathered and it is woken at most once per this gap after its
 * last turn: half a minute per member, ten minutes at most. A lead is woken per post otherwise, and in a large swarm
 * that is one turn of the most expensive member for every question.
 */
const LEAD_GAP_PER_MEMBER_MS = 30_000;
const LEAD_GAP_MAX_MS = 10 * 60_000;
/** Failed turns the engine retries in the member's own session before the member stops and someone has to revive it. */
const AUTO_REVIVES = 1;
/**
 * A queue is starved when this share of its consumers, one at least, is idle while it has nothing to claim. Work in a
 * large swarm is done faster than a lead that is woken every few minutes hands it out, and the counts of a status
 * read the same whether the pending items can be claimed or wait on dependencies.
 */
const STARVED_SHARE = 0.25;
/** A starved queue is reported to the lead after this long, and again this often while it stays starved. */
const STARVED_LEAD_AFTER_MS = 2 * 60_000;
const STARVED_LEAD_EVERY_MS = 15 * 60_000;
/** The main agent hears of it when the lead has not fed the queue this long after being told, and again this often. */
const STARVED_MAIN_AFTER_MS = 20 * 60_000;
const STARVED_MAIN_EVERY_MS = 60 * 60_000;
/** The most of an item's result a handoff quotes; the item holds the rest. */
const HANDOFF_RESULT_CHARS = 1500;
/**
 * The outcomes a lead is owed are gathered into posts when its turn is scheduled: this many items share a post and
 * its room, so one item is quoted at length and a dozen get a line or two each. A turn takes this many posts; what
 * is left over waits for the lead's next turn, which it also wakes.
 */
const HANDOFF_ITEMS_PER_POST = 12;
const HANDOFF_POSTS_PER_TURN = 4;
const HANDOFF_POST_ROOM = 3600;

type SwarmView = Immutable<WorkflowSwarm>;
type MemberView = Immutable<SwarmMember>;
type ItemView = Immutable<WorkflowWorkItem>;

/**
 * A member that plans and judges instead of taking the work: the swarm's lead, and a member that leads queues under
 * it. Such a member runs for as long as the swarm does, so `maxTurns` does not bound it and its turns are not what
 * tells an idle swarm from a working one.
 */
const coordinates = (swarm: SwarmView, member: MemberView) => member.name === swarm.lead || Boolean(member.leads?.length);

/** The member a queue's own work is planned by, while that member runs. */
const queueLead = (swarm: SwarmView, queue: string) => swarm.members.find(member => !member.stopped && member.leads?.includes(queue));

/** Who answers for a queue: its own lead while there is one, the swarm's lead otherwise. */
const answersFor = (swarm: SwarmView, queue: string | undefined) => (queue ? queueLead(swarm, queue) : undefined) ?? swarm.members.find(member => member.name === swarm.lead);

const quoted = (names: readonly string[]) => names.map(name => `"${name}"`).join(', ');

/**
 * A system post in a topic of its own that must not undo the change it reports. It quotes names and members' text,
 * so an @name in it names nobody. A board that is out of topics takes the post without one; a board that cannot take
 * it at all goes without it.
 */
function systemPost(state: WorkflowView, input: { text: string; to?: string[]; topic: string }, now: number): void {
  for (const topic of [input.topic, undefined]) {
    try { postToBoard(state, { author: 'system' }, { ...input, topic }, now, { literal: true }); return; } catch {}
  }
}

function memberName(value: unknown): string {
  const name = scriptText(value, 'swarm member name', 100);
  if (!NAME.test(name) || RESERVED.includes(name)) throw new Error('Swarm member names use 1–40 letters, digits, _, . or -, and cannot be all, main, script or system');
  return name;
}

function role(value: unknown): string | undefined {
  return value === undefined ? undefined : scriptText(value, 'swarm member role', 2000);
}

/** The queues a member is to lead, as `leads` names them: one queue or a list. */
function ledQueues(value: unknown): string[] {
  const names = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(names) || !names.length || names.length > 16 || names.some(name => typeof name !== 'string')) throw new Error('leads is a queue name or an array of 1–16 queue names');
  return [...new Set(names.map(name => queueName(name)))].sort();
}

export function parseSwarm(input: Record<string, unknown>, state: WorkflowView, policy?: WorkerExecutionPolicy) {
  if (Object.keys(input).some(key => !['key', 'task', 'lead', 'members', 'maxTurns'].includes(key))) throw new Error('swarm supports key, lead, members and maxTurns only');
  const key = scriptText(input.key, 'swarm key', 80);
  if (key.trim() !== key || key.startsWith('@')) throw new Error('swarm key must not contain surrounding whitespace or start with @');
  const task = scriptText(input.task, 'swarm task', 16_000);
  if (!task.trim()) throw new Error('swarm needs a task');
  const maxTurns = boundedInteger(input.maxTurns, 6, 1, SWARM_MAX_TURNS);
  if (!Array.isArray(input.members) || !input.members.length) throw new Error('swarm needs members');
  const listed = [...(input.lead === undefined ? [] : [input.lead]), ...input.members];
  if (listed.length > SWARM_DECLARED_MEMBERS) throw new Error(`swarm needs 1–${SWARM_DECLARED_MEMBERS} members, the lead included`);
  const members = listed.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid swarm member');
    const { name, role: description, ...options } = value as Record<string, unknown>;
    if (Object.keys(options).some(option => !['harness', 'model', 'reasoningEffort', 'workflowTool', 'workspace', 'queue', 'leads'].includes(option))) throw new Error('Unsupported swarm member option');
    const { queue, leads, ...execution } = options;
    const call = parseScriptAgentCall({ ...execution, key, member: memberName(name), prompt: task }, state.script!.defaults, state.root, policy);
    return { name: call.member!, role: role(description), selection: call.selection, ...(call.workflowTool ? { workflowTool: true } : {}), ...(call.workspace ? { workspace: call.workspace } : {}), ...(queue !== undefined ? { queue: queueName(queue) } : {}),
      ...(leads !== undefined ? { leads: ledQueues(leads) } : {}) };
  });
  if (new Set(members.map(member => member.name)).size !== members.length) throw new Error('Swarm member names must be unique');
  const led = members.flatMap(member => member.leads ?? []);
  if (led.length) {
    // A queue's lead plans one part of the work; whether the whole is done stays one member's call.
    if (input.lead === undefined) throw new Error('Members that lead queues need a swarm lead, which they report to and which decides when the swarm is done');
    if (members[0]!.leads) throw new Error('The swarm lead answers for every queue without its own lead; leads is for other members');
    if (members.some(member => member.leads && member.queue)) throw new Error('A member that leads queues plans their work and does not consume a queue');
    if (new Set(led).size !== led.length) throw new Error('A queue has one lead');
  }
  return { key, task, maxTurns, members, ...(input.lead === undefined ? {} : { lead: members[0]!.name }) };
}

function ownerOf(state: WorkflowView, name: string | undefined): SwarmView | undefined {
  return state.swarms?.find(swarm => swarm.members.some(member => member.name === name));
}

/** The swarm a member belongs to; its turns are scheduled by the kernel, not by script calls. */
export const memberSwarm = ownerOf;

function nameTaken(state: WorkflowView, name: string): boolean {
  return Boolean(state.agents?.some(agent => agent.key === name) || ownerOf(state, name));
}

/** Called after resolving every member's authorized execution binding. Creates the swarm, or rejoins it on replay. */
export function bindSwarm(state: WorkflowView, spec: ReturnType<typeof parseSwarm>, executions: WorkerExecution[], now: number): void {
  const digest = workflowDigest({ spec, executions });
  const runId = state.script!.runId;
  let swarm = state.swarms?.find(item => item.key === spec.key);
  if (swarm) {
    if (swarm.digest !== digest) throw new Error('Swarm definition changed; its key, task and member bindings are immutable across replay');
    if (swarm.runId === runId) throw new Error('Duplicate swarm call');
  } else {
    if ((state.swarms?.length ?? 0) >= 8) throw new Error('Swarm limit reached');
    if (spec.members.some(member => nameTaken(state, member.name))) throw new Error('Swarm requires dedicated member names not already used in this workflow');
    for (const member of spec.members) for (const name of [...(member.queue ? [member.queue] : []), ...member.leads ?? []]) openQueue(state, name);
    const brief = postToBoard(state, { author: 'script' }, { text: `Swarm "${spec.key}" task:\n` + (spec.task.length > 3800 ? spec.task.slice(0, 3800) + '…[truncated]' : spec.task) }, now);
    const created: WorkflowSwarm = { id: randomUUID(), key: spec.key, digest, runId, task: spec.task, maxTurns: spec.maxTurns, status: 'running',
      firstPost: brief.seq, nudges: 0, turns: [], ...(spec.lead ? { lead: spec.lead } : {}),
      members: spec.members.map((member, index) => ({ name: member.name, execution: executions[index]!, turns: 0,
        ...(member.role !== undefined ? { role: member.role } : {}), ...(member.workflowTool ? { workflowTool: true } : {}), ...(member.workspace ? { workspace: member.workspace } : {}), ...(member.queue ? { queue: member.queue } : {}),
        ...(member.leads ? { leads: member.leads } : {}) })) };
    emit(state, { type: 'swarm_created', swarm: created });
    return;
  }
  // Rebuild each member's committed turn chain without running its completed turns again.
  const completed = swarm.turns.filter(turn => taskById(state, turn.taskId)?.status === 'result_ready');
  // Archived turns all completed; they count as calls of this run without being listed in it.
  const archivedCalls = swarm.archivedTurns ?? 0;
  if (callCount(state) + completed.length + archivedCalls > state.script!.maxCalls) throw new Error('Script agent call limit reached');
  for (const turn of completed) emit(state, { type: 'script_call_recorded', call: { key: turn.key, taskId: turn.taskId, cached: true } });
  // A swarm that failed is what an explicit replay is for: it runs again from its records. Its failed members
  // retry their turn like the ones a pause cut short, and the queues the script closed once the swarm had returned
  // take new work again. A swarm that finished or went quiet keeps its result.
  const reopened = swarm.status === 'done' && swarm.stop === 'failed' && !swarm.finish;
  if (reopened) {
    for (const member of swarm.members) if (member.stopped === 'failed') emit(state, { type: 'swarm_member_revived', swarmId: swarm.id, member: member.name });
    for (const name of new Set(swarm.members.flatMap(member => member.queue ? [member.queue] : []))) {
      if (queueControl(state, name)?.closedAt !== undefined) emit(state, { type: 'work_queue_reopened', name });
    }
  }
  const retryPending = swarm.members.filter(member => !member.stopped && member.taskId && taskById(state, member.taskId)?.status !== 'result_ready').map(member => member.name);
  emit(state, { type: 'swarm_rebound', swarmId: swarm.id, runId, retryPending, ...(archivedCalls ? { archivedCalls } : {}), ...(reopened ? { reopened } : {}) });
}

const PLAN_ONLY = 'You plan and judge; you do not do the work. Do not write code or run builds, tests or measurements yourself, except to check a result before you rely on it';
/** What makes an item one a member can finish alone, and how far ahead of its members a queue is kept. */
const ITEM_RULES = 'An item is one result that a single member can finish and check in one turn: say what is wanted, where, and the check that tells done from not done. '
  + 'Split what is larger, and what two members could not do at once without touching the same files. Members finish items faster than you are woken, so plan ahead of them: '
  + 'when you end a turn, each queue should hold at least one claimable item for every member that consumes it. Where a part has no more useful work, say so instead of inventing items';

/** How the outcomes of items reach the lead that planned them. */
const HANDED_BACK = 'at your next turn the system posts the outcomes in topic "handoff", gathered, with a line or two for each item when many came back (work_status({key}) has an item in full). '
  + 'Read them before you hand out more, and judge them on evidence (test output, measurements) rather than on reports';
/** What a lead can do to the items of a queue it plans once they are in it. */
const ITEM_CHANGES = 'Items stay yours to change until they are done. update_work({key, ...}) moves one ahead or back (priority), sets it aside and returns it (hold: true, false) or withdraws it (cancel: true; '
  + 'an item a member has claimed must come back from that member first), and retry_work({key}) gives a failed one more attempts. When the direction changes, cancel or hold what no longer serves it instead of leaving it for members to claim.';

/**
 * What a member is told once, in its first turn. Its own part comes first: what it is there to do, who plans its
 * work and who gets its results. How turns and the board work is the same for everyone and follows.
 */
function rules(swarm: SwarmView, member: MemberView): string {
  const lead = swarm.lead === member.name;
  const led = member.leads ?? [];
  const coordinator = coordinates(swarm, member);
  const own = member.queue ? queueLead(swarm, member.queue) : undefined;
  const delegates = swarm.members.filter(item => !item.stopped && item.leads?.length);
  const part = lead ? [
    '- You are the lead. You turn the task into work for the members, judge what comes back and decide when the swarm is done.',
    `- ${PLAN_ONLY}: every piece of work goes to a member or into a queue.`,
    `- Hand out work as queue items with enqueue_work wherever a queue has members, and by naming members on the board where no queue fits. ${ITEM_RULES}, and retire the members it no longer needs.`,
    '- Queue items come back to you when a member completes them or they fail for good' + (delegates.length ? ', or to the lead of their queue when you did not add them yourself' : '')
      + `: ${HANDED_BACK}. The system also posts to you when a member fails, when a queue runs dry (with the number of items it lacks) and when everyone has gone idle.`,
    `- ${ITEM_CHANGES}`,
    ...(delegates.length ? [`- These members lead parts of the work under you: ${delegates.map(item => `${item.name} (${item.leads!.length > 1 ? 'queues' : 'queue'} ${quoted(item.leads!)})`).join(', ')}. `
      + 'Give each the goal of its part on the board and let it split that into items for its queues; it reports to you. Add an item to such a queue yourself only when its result should come back to you.'] : []),
    '- Idle members and an empty queue do not mean the task is done. The swarm ends only when you call swarm_finish: do so once the goal is met or cannot progress, with the final result, stating which it is and what remains. The turns still running then finish and nobody is woken again.',
    '- The charter is the goal as it stands now, and every member is given it at every turn. When the direction, the priorities or the way results are measured change, replace it with set_charter instead of adding another announcement, and keep it short and current. '
      + 'Rules and rulings that every member must follow go in topic "announce" instead of naming all: members get them at their next turn without being woken. staff_swarm adds members while the swarm runs, retires them and revives failed ones.',
    '- Before you end a turn while work is in flight, set wake_me so that you come back to check results against the charter even if nobody names you.',
  ] : led.length ? [
    `- You lead ${led.length > 1 ? 'queues' : 'queue'} ${quoted(led)} under @${swarm.lead}: that part of the task is yours to plan, and its results are yours to judge.`,
    `- ${PLAN_ONLY}: every piece of work goes into a queue.`,
    `- Hand out work with enqueue_work, naming the queue. ${ITEM_RULES}, and tell @${swarm.lead}.`,
    `- The items of your queues, and the ones you added to another queue, come back to you when a member completes them or they fail for good: ${HANDED_BACK}. `
      + 'The system also posts to you when a member of your queues fails and when one of them runs dry, with the number of items it lacks.',
    `- ${ITEM_CHANGES}`,
    `- Report to @${swarm.lead} what your part has achieved, what blocks it and what it needs from other parts. @${swarm.lead} decides when the swarm is done; staff_swarm, swarm_finish, set_charter and topic "announce" are its to use.`,
    '- Before you end a turn while work of your queues is in flight, set wake_me so that you come back to check its results even if nobody names you. When you have nothing to report and need nothing, end the turn without posting.',
  ] : [
    ...(member.queue ? [
      `- You consume work queue "${member.queue}". Use claim_work to take an item, read item.progress before acting, save checkpoint_work as you go, then complete_work or fail_work. Continue until claim_work returns null, then end the turn; do not poll or sleep waiting for work.`,
      '- Do what the item asks and check it the way the item says before complete_work. Work that is not finished is not complete: when you cannot finish, fail_work with what blocks you (retry: true only when another attempt could succeed), or save checkpoint_work and go on in your next turn.',
      '- Stay inside your item. A problem you find outside it is new work: look for it with search_work, and if nobody has reported it add it with enqueue_work, instead of fixing it yourself or leaving it unsaid. '
        + 'An item you added and no longer want done you withdraw with update_work({key, cancel: true}) while nobody has claimed it.',
      '- Do not post a report when you complete an item: the result you give complete_work is the report, and search_work finds it.'
        + (swarm.lead ? ' The system hands it to the lead that planned the item, so say in it what you did, what you found, where you departed from the item and what still worries you.' : '')
        + ' Post only what someone else must act on.',
    ] : []),
    swarm.lead ? (own ? `- @${own.name} leads your queue "${member.queue}": it adds the queue's work and is handed your results, so report blockers on that work to it. @${swarm.lead} leads the swarm and decides when it is done.`
        : `- @${swarm.lead} is the lead: it assigns work and decides when the swarm is done. Report results and blockers to it.`) + ' When you have nothing to report and need nothing, end the turn without posting.'
      : '- When you need nothing from anyone and have nothing to report, end the turn without posting. The swarm finishes when everyone is asleep.',
  ];
  return [
    'Your part:',
    ...part,
    ...(lead ? [] : ['- When your prompt carries a charter, it is the goal as it stands now: where it differs from the task or from earlier posts, the charter wins.']),
    'How turns work:',
    '- Your turn ends with your final answer. You then sleep at no cost and are woken only when a post names you' + (member.queue ? ' or your queue has work you can claim' : '') + '; the posts arrive in read_context (member.messages).',
    (coordinator ? '- Your wake-ups are not limited, but while other members are working the posts that name you are gathered and you are woken for them every few minutes, so handle everything that has arrived in one turn.'
      : `- After this first turn you can be woken at most ${swarm.maxTurns} times.`)
      + ' Save a checkpoint of your working state before ending a turn. Your final answer is a short status note for the workflow log; teammates only see board posts.',
    '- wake_me wakes you after a delay without anyone naming you. To wait for a long build, test or queue, or to check on something later, save a checkpoint, set it and end the turn; do not hold the turn polling or sleeping.',
    'The board:',
    '- The board is one ordered feed that every member can read. Post with post_board and name who must act in "to" (member names, or "all"); read with read_board.',
    '- Every post that names a member costs that member a turn. Post results, questions, hand-offs and blockers that someone must act on, with enough detail to act without asking back; do not post acknowledgements or thanks.',
    '- Give each post the topic of its workstream and keep that name; read and search one topic at a time instead of the whole feed. Topic "announce" carries rules and rulings from the lead and the main agent: the new ones are in read_context (board.announcements) every turn, and they bind you.',
  ].join('\n');
}

/** The members as a member is shown them: those with the same standing, queue and role share a line. */
function roster(swarm: SwarmView): string {
  const lines = new Map<string, string[]>();
  for (const item of swarm.members) {
    if (item.stopped) continue;
    const standing = (item.name === swarm.lead ? ' (lead)' : item.leads?.length ? ` (leads ${quoted(item.leads)})` : item.queue ? ` (queue "${item.queue}")` : '') + (item.role ? ' — ' + item.role : '');
    lines.set(standing, [...lines.get(standing) ?? [], '@' + item.name]);
  }
  return [...lines].map(([standing, names]) => names.join(', ') + standing).join('\n');
}

function openingPrompt(swarm: SwarmView, member: MemberView): string {
  return `You are member "${member.name}" of swarm "${swarm.key}", which coordinates through a shared message board.`
    + (member.role ? '\nYour role: ' + member.role : '') + '\nTask:\n' + swarm.task
    + (member.brief ? '\nYou were added while the swarm was running, with this brief:\n' + member.brief : '') + '\nMembers:\n' + roster(swarm) + '\n' + rules(swarm, member)
    + '\nThis is your first turn. Start on your part of the task now; if your role only reacts to others, end the turn with a one-line note.';
}

/**
 * What a member is told at every later turn. The rules of its first turn may have left its context by then, so a
 * lead is reminded of its part and shown how its queues stand (`queues`), which is what it is woken to act on.
 */
function wakePrompt(swarm: SwarmView, member: MemberView, timed: boolean, queues?: string): string {
  const plans = coordinates(swarm, member);
  return `Swarm "${swarm.key}", wake-up ${member.turns + 1}${plans ? '' : ' of at most ' + swarm.maxTurns}: board posts that name you are in read_context (member.messages). `
    + (timed ? `The wake-up you set with wake_me is due${member.wakeNote ? ': ' + member.wakeNote : ''}. ` : '')
    + 'Follow the new announcements in read_context (board.announcements). Act on the posts, use read_board for wider context, and post what others need.'
    + (plans ? ` You ${member.name === swarm.lead ? 'are the lead' : `lead ${member.leads!.length > 1 ? 'queues' : 'queue'} ${quoted(member.leads!)}`}: you plan and judge and do not do the work yourself. `
      + 'Read what has come back (topic "handoff"), judge it against the charter or the task, and before you end the turn leave each queue '
      + (member.name === swarm.lead && swarm.members.some(item => !item.stopped && item.leads?.length) ? 'that has no lead of its own ' : member.name === swarm.lead ? '' : 'of yours ')
      + 'with at least one claimable item for every member that consumes it, or say that it has no more work.' + (queues ? ` Queues now: ${queues}.` : '') : '')
    + (member.queue ? ` Then consume queue "${member.queue}" with claim_work until it returns null; you may have been woken for new work alone.` : '') + ' End with a short status note.';
}

/** Turns the swarm has scheduled, archived ones included. */
function turnCount(swarm: SwarmView): number {
  return swarm.turns.length + (swarm.archivedTurns ?? 0);
}

/** Schedules the turns of every running swarm and settles the ones with nothing left to do. Returns whether anything changed. */
export function pumpSwarms(state: WorkflowView, nativeIdKind: (agentKind: string) => NativeIdKind, now: number, additionalTurnsAllowed = Infinity): boolean {
  let changed = false;
  for (const swarm of state.swarms ?? []) {
    const before = swarm.turns.length;
    changed = pumpSwarm(state, swarm, nativeIdKind, now, additionalTurnsAllowed) || changed;
    additionalTurnsAllowed -= swarm.turns.length - before;
  }
  return changed;
}

function pumpSwarm(state: WorkflowView, swarm: SwarmView, nativeIdKind: (agentKind: string) => NativeIdKind, now: number, additionalTurnsAllowed: number): boolean {
  if (swarm.runId !== state.script?.runId || state.status !== 'active' || state.script.status !== 'running' || swarm.status !== 'running') return false;
  let changed = false;
  const record = (event: DomainEvent) => { emit(state, event); changed = true; };
  const end = (stop: NonNullable<WorkflowSwarm['stop']>, reason?: string) => record({ type: 'swarm_ended', swarmId: swarm.id, stop, ...(reason ? { reason } : {}) });
  const taskOf = (member: MemberView) => taskById(state, member.taskId);
  const busy = (member: MemberView) => { const task = taskOf(member); return Boolean(task && BUSY.has(task.status)); };
  // Looked up for every member on every pass, so indexed once rather than searched.
  const agents = new Map((state.agents ?? []).map(agent => [agent.key, agent]));
  const agentOf = (member: MemberView) => agents.get(member.name);
  const unread = (member: MemberView) => { const agent = agentOf(member); return Boolean(agent && availableMessages(state, agent.agentId).length); };
  const notify = (lead: MemberView | undefined, text: string) => {
    if (!lead || lead.stopped || !agentOf(lead)) return;
    postToBoard(state, { author: 'system' }, { text, to: [lead.name] }, now);
    changed = true;
  };
  const notifyLead = (text: string) => notify(swarm.members.find(member => member.name === swarm.lead), text);
  /** Told that a member has stopped: the lead of the queue it consumed, who plans that work, else the swarm's lead. */
  const stoppedNotice = (member: MemberView, what: string, detail: string) => {
    if (member.name === swarm.lead) return;
    const lead = answersFor(swarm, member.queue);
    notify(lead, `Member "${member.name}"${lead?.name === swarm.lead ? '' : ` of queue "${member.queue}"`} ${what} and has stopped: ${detail}\n`
      + (lead?.name === swarm.lead ? 'Reassign its work, add a replacement or revive it with staff_swarm, or finish.'
        : `An item it had claimed returns to the queue while it has attempts left. Ask the lead (${swarm.lead}) for a replacement or a revival if the queue needs one.`));
  };
  try {
    // A turn that ended without a result during this run is a failure; turns cut short by a pause are retried instead.
    for (const member of swarm.members) {
      const task = taskOf(member);
      if (member.stopped || member.retryPending || !task || BUSY.has(task.status) || task.status === 'result_ready') continue;
      const detail = (task.error ?? `turn is ${task.status}`).slice(0, 500);
      // A failed turn runs once more in the member's session, as staff_swarm's revive would have it, before the
      // member stops: nobody watches a large swarm closely enough to revive each member that hit a passing fault.
      if (task.status === 'failed' && !swarm.finish && (member.autoRevived ?? 0) < AUTO_REVIVES) {
        record({ type: 'task_requeued', taskId: task.taskId, runId: state.script.runId });
        record({ type: 'swarm_member_revived', swarmId: swarm.id, member: member.name, auto: true });
        continue;
      }
      record({ type: 'swarm_member_stopped', swarmId: swarm.id, member: member.name, reason: 'failed', detail });
      if (swarm.finish) continue;
      // Naming the member without @ keeps the notice from being delivered to it.
      stoppedNotice(member, 'failed', detail);
      pushEvent(state, { kind: 'swarm_attention', summary: `swarm "${swarm.key}" 的成员 ${member.name} 失败并已停止`
        + `${task.status === 'failed' ? '（已自动重试一次）' : ''}：${detail.slice(0, 200)}。staff_swarm 的 revive 可让它在原会话重试，add 可补人。` }, () => now);
    }
    const lead = swarm.members.find(member => member.name === swarm.lead);
    // Work a queue member could claim now, less the turns already running that have not claimed yet.
    const queues = [...new Set(swarm.members.flatMap(member => member.queue && !member.stopped ? [member.queue] : []))];
    const claiming = new Set(queues.length ? (state.workQueue?.claims ?? []).flatMap(claim => claim.status === 'active' ? [claim.taskId] : []) : []);
    const work = new Map(queues.map(name => {
      const available = availableWork(state, name);
      const unclaimed = (state.swarms ?? []).flatMap(other => other.members).filter(member => member.queue === name)
        .map(member => taskById(state, member.taskId)).filter(task => task && BUSY.has(task.status) && !task.consumerMessageTurn
          && !claiming.has(task.taskId)).length;
      let digest: string | undefined;
      // Identifies the claimable set a member was last woken for; only computed when a member is idle with work to offer.
      return [name, { slots: available.length - unclaimed,
        get wake() { return digest ??= workflowDigest(available.map(item => ({ id: item.id, generation: item.generation }))); } }];
    }));
    const hasWork = (member: MemberView) => { const found = member.queue ? work.get(member.queue) : undefined; return Boolean(found && found.slots > 0 && member.lastWake !== found.wake); };
    // A lead coordinates for as long as the swarm runs, so maxTurns bounds the other members only.
    const turnsLeft = (member: MemberView) => coordinates(swarm, member) || member.turns < swarm.maxTurns;
    const running = swarm.members.filter(member => !member.stopped);
    // The swarm's lead gathers for every member, the lead of a queue for the members of its queues.
    const gap = (member: MemberView) => Math.min(LEAD_GAP_MAX_MS, LEAD_GAP_PER_MEMBER_MS
      * (member.name === swarm.lead ? running.length : Math.max(1, running.filter(other => other.queue && member.leads?.includes(other.queue)).length)));
    // With nobody else working there is nothing to gather for, and the lead is woken at once.
    const gathering = (member: MemberView) => coordinates(swarm, member) && now - (taskOf(member)?.attempts.at(-1)?.endedAt ?? 0) < gap(member)
      && swarm.members.some(other => other !== member && busy(other)) && !toldLately(member);
    // Queues whose consumers have run out of work while others are still busy: the lead that answers for the queue is
    // told at once, and the main agent when that did not help. A swarm that is idle altogether is the nudges' and the
    // stall's business.
    for (const name of new Set([...queues, ...Object.keys(swarm.starved ?? {})])) {
      const answers = answersFor(swarm, name);
      const consumers = swarm.members.filter(member => member.queue === name && !member.stopped && turnsLeft(member));
      const idle = consumers.filter(member => !busy(member)).length;
      const entry = swarm.starved?.[name];
      if (!answers || answers.stopped || swarm.finish || !swarm.members.some(member => member !== answers && busy(member))
        || (work.get(name)?.slots ?? 1) > 0 || idle < Math.max(1, Math.ceil(consumers.length * STARVED_SHARE))) {
        if (entry) record({ type: 'swarm_queue_fed', swarmId: swarm.id, queue: name, at: now });
        continue;
      }
      if (!entry) { record({ type: 'swarm_queue_starved', swarmId: swarm.id, queue: name, at: now }); continue; }
      const blocked = (state.workQueue?.items ?? []).filter(item => (item.queue ?? 'default') === name && item.status === 'pending').length;
      const facts = `${idle} of its ${consumers.length} members are idle and it has no item they can claim`
        + (blocked ? ` (${blocked} pending items wait on dependencies, resources or attempts, or are on hold)` : '');
      if (now - entry.since >= STARVED_LEAD_AFTER_MS && now - (entry.leadAt ?? -Infinity) >= STARVED_LEAD_EVERY_MS) {
        record({ type: 'swarm_queue_starved', swarmId: swarm.id, queue: name, at: now, told: 'lead' });
        notify(answers, `Queue "${name}" has run dry: ${facts}. Add at least ${idle} items for it with enqueue_work now; if there is no more work for it, `
          + (answers.name === swarm.lead ? 'say so on the board or retire members.' : `tell the lead (${swarm.lead}).`));
      } else if (entry.leadAt !== undefined && now - entry.since >= STARVED_MAIN_AFTER_MS && now - (entry.mainAt ?? -Infinity) >= STARVED_MAIN_EVERY_MS) {
        record({ type: 'swarm_queue_starved', swarmId: swarm.id, queue: name, at: now, told: 'main' });
        pushEvent(state, { kind: 'swarm_attention', summary: `swarm "${swarm.key}" 的队列 ${name} 已断粮 ${Math.round((now - entry.since) / 60_000)} 分钟：`
          + `${consumers.length} 名成员中 ${idle} 名空闲，没有可领工作项` + (blocked ? `（${blocked} 项待领但被依赖、资源、尝试次数或挂起挡住）` : '')
          + '，lead 已被提醒但未补充。用 enqueue_work 补充该队列，或 staff_swarm 的 retire 减人。' }, () => now);
      }
    }
    // How the queues a lead answers for stand, for its wake-up: what can be claimed against the members with nothing to do.
    const standing = (member: MemberView) => !coordinates(swarm, member) ? undefined : queues.filter(name => member.name === swarm.lead || member.leads?.includes(name)).map(name => {
      const consumers = swarm.members.filter(other => other.queue === name && !other.stopped);
      const own = member.name === swarm.lead ? queueLead(swarm, name) : undefined;
      return `"${name}" ${Math.max(0, work.get(name)!.slots)} claimable, ${consumers.filter(other => !busy(other)).length} of ${consumers.length} members idle, `
        + `${workFlow(state, name, now)?.completed.at(-1) ?? 0} items completed in the last hour` + (own ? ` (lead ${own.name})` : '');
    }).join('; ') || undefined;
    // The outcomes each lead is owed, by whoever plans the item now. One that has nobody to go to (its lead settled the
    // item itself, or has stopped), or whose item is back in the queue, is dropped: the item still holds it.
    const owed = new Map<string, Array<{ item: ItemView; worker: string }>>();
    const dropped: string[] = [];
    // The same few leads plan every item, so each is looked up once.
    const planners = new Map<string, MemberView | undefined>();
    // An item that failed, was retried and settled again is owed once, as it stands now.
    const seen = new Set<string>();
    for (const entry of swarm.handoffs ?? []) {
      if (seen.has(entry.item)) continue;
      seen.add(entry.item);
      const item = workItem(state, entry.item);
      const settled = item && (item.status === 'completed' || item.status === 'failed') ? item : undefined;
      const planner = settled && `${settled.by ?? ''}\n${settled.queue ?? 'default'}`;
      if (planner !== undefined && !planners.has(planner)) planners.set(planner, plannedBy(swarm, settled!));
      const to = planner === undefined ? undefined : planners.get(planner);
      if (!settled || !to || to.stopped || to.name === entry.worker) { dropped.push(entry.item); continue; }
      // A lead that has not had its first turn yet is handed what came back once it has.
      if (!agentOf(to)) continue;
      const list = owed.get(to.name);
      if (list) list.push({ item: settled, worker: entry.worker }); else owed.set(to.name, [{ item: settled, worker: entry.worker }]);
    }
    if (dropped.length) record({ type: 'swarm_handoffs_delivered', swarmId: swarm.id, items: dropped });
    /** Posts to a lead, as its turn is scheduled, what has come back for it since its last one. */
    const handOver = (member: MemberView) => {
      const all = owed.get(member.name) ?? [];
      const batch = all.slice(0, HANDOFF_ITEMS_PER_POST * HANDOFF_POSTS_PER_TURN);
      if (!batch.length) return;
      for (let at = 0; at < batch.length; at += HANDOFF_ITEMS_PER_POST) {
        const last = at + HANDOFF_ITEMS_PER_POST >= batch.length;
        // Lost to a full board, an outcome is still in its item, where work_status and search_work find it.
        systemPost(state, { text: handoffPost(batch.slice(at, at + HANDOFF_ITEMS_PER_POST), batch.length, last ? all.length - batch.length : 0), to: [member.name], topic: BOARD_HANDOFF_TOPIC }, now);
      }
      record({ type: 'swarm_handoffs_delivered', swarmId: swarm.id, items: batch.map(entry => entry.item.id) });
      owed.delete(member.name);
    };
    // A starved queue does not wait for its lead's gathering gap: the notice wakes it for the turn that follows.
    const toldLately = (member: MemberView) => Object.entries(swarm.starved ?? {}).some(([name, entry]) => answersFor(swarm, name) === member
      && (entry.leadAt ?? 0) > (taskOf(member)?.attempts.at(-1)?.startedAt || 0));
    // Once the lead has finished the swarm, the turns still running end it; nobody is woken again.
    // A wake-up the member set for itself is due; unlike posts it is not gathered, since the member chose the time.
    const due = (member: MemberView) => member.wakeAt !== undefined && member.wakeAt <= now;
    const wakeable = (member: MemberView) => !member.stopped && !busy(member) && !swarm.finish
      && (member.retryPending || (member.taskId ? turnsLeft(member) && (due(member) || !gathering(member) && (unread(member) || hasWork(member) || owed.has(member.name)))
        // A queue consumer starts with its first claimable item instead of an opening turn with nothing to do.
        : !member.queue || hasWork(member)));
    if (!swarm.members.some(busy) && !swarm.members.some(wakeable)) {
      if (lead?.stopped === 'failed') { end('failed', 'The lead failed: ' + (lead.detail ?? '')); return changed; }
      if (swarm.finish) { end('finished'); return changed; }
      // A member waiting for its own wake-up has work in flight, so the swarm is neither idle nor done. The lead's
      // wake-up is not work: a lead that only keeps coming back to an idle swarm is still reminded, and then reported.
      if (swarm.members.some(member => !coordinates(swarm, member) && !member.stopped && member.wakeAt !== undefined && turnsLeft(member))) return changed;
      if (lead) {
        // Idle members are not a verdict: a swarm with a lead ends only when the lead finishes it.
        if (swarm.nudges < MAX_NUDGES) {
          record({ type: 'swarm_nudged', swarmId: swarm.id });
          notifyLead('Every member is idle and nothing is waiting to be read. Check the goal, as the charter or else the task states it, against evidence. If it is not met, find what is missing and hand it out: '
            + 'add items with enqueue_work, or name members on the board. Call swarm_finish only when the goal is met or cannot progress, and say which.');
        } else if (!swarm.stalled) {
          record({ type: 'swarm_stalled', swarmId: swarm.id });
          pushEvent(state, { kind: 'swarm_stalled', summary: `swarm "${swarm.key}" 停滞：全体成员空闲，`
            + `lead 经 ${MAX_NUDGES} 次提醒仍未分派工作，也未调用 swarm_finish`
            + '。swarm 仍在运行并等待：用 post_board 点名成员继续、enqueue_work 补充工作，或 staff_swarm 加人、提高 maxTurns；确认无事可做再取消。' }, () => now);
        }
        return changed;
      } else if (queues.some(name => availableWork(state, name).length)) {
        end('failed', 'No member can take the available work: its consumers have stopped or used their wake-ups; inspect member failures and explicitly replay');
        return changed;
      } else if (queues.some(name => queueControl(state, name)?.closedAt === undefined)) {
        // Without a lead, an open queue means producers may still add work: keep waiting.
        return changed;
      } else if (queues.some(name => unfinishedWork(state, name) || state.workQueue?.items.some(item => (item.queue ?? 'default') === name && item.status === 'failed'))) {
        end('failed', 'Swarm went idle with failed or unclaimable work items; inspect /workflow work, retry them, then explicitly replay');
        return changed;
      } else {
        const active = swarm.members.filter(member => !member.stopped || member.stopped === 'failed');
        end(active.some(member => member.stopped === 'failed') ? 'failed' : active.some(member => member.turns >= swarm.maxTurns && unread(member)) ? 'max_turns' : 'quiet');
        return changed;
      }
    }
    let slots = state.definition.maxConcurrentWorkers - state.tasks.filter(task => BUSY.has(task.status)).length;
    for (const member of swarm.members) {
      if (slots <= 0) break;
      if (!wakeable(member)) continue;
      if (member.workspace && state.tasks.some(task => task.workspaceId === member.workspace && (BUSY.has(task.status) || task.status === 'waiting_workflow'))) continue;
      const prior = taskOf(member);
      const retry = Boolean(member.retryPending && prior);
      if (callCount(state) >= state.script.maxCalls || !retry && additionalTurnsAllowed <= 0) {
        if (!swarm.members.some(busy)) end('failed', 'Swarm ran out of the workflow\'s agent call budget; raise maxAgents or reduce members and maxTurns');
        break;
      }
      const opening = !member.taskId;
      const timed = !retry && !opening && due(member);
      const key = retry ? prior!.scriptKey! : `@swarm/${swarm.id}/${turnCount(swarm)}`;
      const call = { key, member: member.name, prompt: retry ? readText(state, prior!.objective) : opening ? openingPrompt(swarm, member) : wakePrompt(swarm, member, timed, standing(member)),
        ...(member.workflowTool ? { workflowTool: true } : {}), ...(member.workspace ? { workspace: member.workspace } : {}),
        output: 'text' as const, selection: { agentKind: member.execution.agentKind, ...member.execution.modelSettings } };
      if (!retry && !opening) handOver(member);
      const mail = unread(member);
      const queued = member.queue ? work.get(member.queue)! : undefined;
      const forWork = Boolean(queued && queued.slots > 0);
      let task;
      try {
        if (!retry && !opening && mail) receiveMessages(state, member.name, key + '/inbox');
        ({ task } = scheduleMemberTurn(state, call, member.execution, nativeIdKind(member.execution.agentKind)));
      } catch (error) {
        // One member whose records do not let it take a turn stops like a member whose turn failed; the others go on.
        const detail = ('cannot be scheduled: ' + (error instanceof Error ? error.message : String(error))).slice(0, 500);
        record({ type: 'swarm_member_stopped', swarmId: swarm.id, member: member.name, reason: 'failed', detail });
        stoppedNotice(member, 'could not be woken', detail);
        pushEvent(state, { kind: 'swarm_attention', summary: `swarm "${swarm.key}" 的成员 ${member.name} 无法被唤醒并已停止：${detail.slice(0, 200)}。staff_swarm 的 add 可补人。` }, () => now);
        continue;
      }
      // A turn woken only by posts is not demand for a work item.
      if (!retry && queued && !forWork && !task.consumerMessageTurn) record({ type: 'task_message_turn_marked', taskId: task.taskId });
      if (forWork) queued!.slots--;
      record({ type: 'swarm_turn_scheduled', swarmId: swarm.id, member: member.name, key, taskId: task.taskId, retry, opening, ...(queued ? { wake: queued.wake } : {}), ...(timed ? { timer: true } : {}) });
      record({ type: 'script_call_recorded', call: { key, taskId: task.taskId, cached: false } });
      if (!retry) additionalTurnsAllowed--;
      slots--;
    }
  } catch (error) { end('failed', error instanceof Error ? error.message : String(error)); }
  return changed;
}

/** The lead of a running swarm, for the management operations only it may call. */
function leadSwarm(state: WorkflowView, caller: string): SwarmView {
  const swarm = ownerOf(state, caller);
  if (!swarm || swarm.lead !== caller) throw new Error('Only the lead of a swarm can manage it');
  if (swarm.status !== 'running' || swarm.runId !== state.script?.runId) throw new Error('Swarm is no longer running');
  if (swarm.finish) throw new Error('Swarm is already finishing');
  return swarm;
}

function runningSwarm(state: WorkflowView, key: unknown): SwarmView {
  const running = (state.swarms ?? []).filter(swarm => swarm.status === 'running' && swarm.runId === state.script?.runId && !swarm.finish);
  const swarm = key === undefined ? (running.length === 1 ? running[0] : undefined) : running.find(item => item.key === scriptText(key, 'swarm key', 80));
  if (!swarm) throw new Error(key === undefined ? `Name the swarm: ${running.map(item => item.key).join(', ') || 'none is running'}` : 'No running swarm has this key');
  return swarm;
}

const EXECUTION_OPTIONS = ['harness', 'model', 'reasoningEffort'];

/** The member whose binding, role and queue new members take over: the first that does the work, unless one is named. */
function likeMember(swarm: SwarmView, like: unknown): MemberView {
  const found = like === undefined ? swarm.members.find(member => !coordinates(swarm, member)) ?? swarm.members[0]! : swarm.members.find(member => member.name === like);
  if (!found) throw new Error('like must name an existing member of this swarm');
  return found;
}

/**
 * The harness and model `staff_swarm` asks for when it does not bind its new members like an existing one; undefined
 * when it does. What is not named comes from the `like` member, except that another harness does not inherit a model.
 * The host resolves the selection to an execution binding before `staffSwarm` runs.
 */
export function staffSelection(state: WorkflowView, input: Record<string, unknown>, policy?: WorkerExecutionPolicy): WorkerExecutionSelection | undefined {
  if (!EXECUTION_OPTIONS.some(option => input[option] !== undefined)) return undefined;
  if (input.add === undefined) throw new Error('harness, model and reasoningEffort bind the members that add names');
  const { execution } = likeMember(runningSwarm(state, input.swarm), input.like);
  const harness = input.harness ?? execution.agentKind;
  const { model, reasoningEffort } = harness === execution.agentKind ? execution.modelSettings : {} as WorkerExecution['modelSettings'];
  return workerSelection({ agentKind: harness, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}), ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}) }, state.root, policy);
}

/**
 * The worktrees `staff_swarm` makes for the members it adds, one per name; undefined when it asks for none. A member
 * that is added without one runs in the workflow's own checkout, where editing code races the main agent and the
 * other members, and cannot submit work through a landing branch. Creation is the host operation behind the script's
 * `createWorkspace`, keyed by swarm and member, so a retried call reuses the worktree it already made; `staffSwarm`
 * binds the IDs in the change that adds the members.
 */
export async function staffWorkspaces(ctx: KernelContext, state: WorkflowView, input: Record<string, unknown>): Promise<Record<string, string> | undefined> {
  if (input.workspace === undefined || input.workspace === false) return undefined;
  if (input.add === undefined) throw new Error('workspace binds the members that add names');
  if (!ctx.host.workspace) throw new Error('Workspace creation is unavailable in this workflow');
  if (state.parent) throw new Error('Workspace operations are unavailable in this workflow');
  if (state.status !== 'active' || state.script?.status !== 'running') throw new Error('Workflow is inactive');
  const options = input.workspace === true ? {} : input.workspace;
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['base', 'repo', 'isolation'].includes(key))) throw new Error('workspace is true or an object with base, repo and isolation');
  const swarm = runningSwarm(state, input.swarm);
  const like = likeMember(swarm, input.like);
  if (like.workflowTool) throw new Error('Workspace v1 does not support nested workflow delegation');
  if (!Array.isArray(input.add) || !input.add.length || input.add.length > 64) throw new Error('add is an array of 1–64 new member names');
  const names = input.add.map(memberName);
  if (new Set(names).size !== names.length) throw new Error('Member names must be unique');
  if (swarm.members.length + names.length > SWARM_MAX_MEMBERS) throw new Error(`A swarm holds at most ${SWARM_MAX_MEMBERS} members, retired ones included`);
  const taken = names.find(name => nameTaken(state, name));
  if (taken) throw new Error('Member name is already used in this workflow: ' + taken);
  // Validate what the change will re-check, so a rejected staffing call does not leave worktrees behind.
  if (input.queue !== undefined) queueName(input.queue);
  if (input.leads !== undefined && (ledQueues(input.leads), names.length !== 1)) throw new Error('leads makes one member the lead of its queues; add that member alone');
  if (input.role !== undefined) role(input.role);
  if (input.brief !== undefined) scriptText(input.brief, 'member brief', 4000);
  if (input.maxTurns !== undefined) {
    const maxTurns = boundedInteger(input.maxTurns, swarm.maxTurns, 1, SWARM_MAX_TURNS);
    if (maxTurns < swarm.maxTurns) throw new Error(`maxTurns can only be raised; it is ${swarm.maxTurns}`);
  }
  if (input.maxConcurrent !== undefined) boundedInteger(input.maxConcurrent, state.definition.maxConcurrentWorkers, 1, MAX_CONCURRENT_WORKERS);
  const signal = new AbortController().signal;
  const made = await Promise.all(names.map(async name => {
    const created = await ctx.host.workspace!(ctx.store.public(state), { kind: 'create', key: `staff/${swarm.id}/${name}`, ...options }, signal) as { id?: unknown };
    if (typeof created?.id !== 'string') throw new Error('Workspace creation did not return an ID');
    return [name, created.id] as const;
  }));
  return Object.fromEntries(made);
}

/** The members a cleanup names: those it lists, or every retired member that still holds a worktree. */
function cleanupNames(swarm: SwarmView, value: unknown): string[] {
  const names = value === 'retired'
    ? swarm.members.filter(member => member.stopped === 'retired' && member.workspace && !member.cleaned).map(member => member.name)
    : Array.isArray(value) ? value.map(name => scriptText(name, 'member name', 100)) : undefined;
  if (!names) throw new Error('cleanup is "retired" or an array of member names');
  if (names.length > 64) throw new Error('cleanup names at most 64 members');
  if (new Set(names).size !== names.length) throw new Error('Member names must be unique');
  return names;
}

/** The members whose worktrees a cleanup may release; already-cleaned ones are left out. */
function pendingCleanup(swarm: SwarmView, names: string[]): Array<{ name: string; workspace: string }> {
  return names.flatMap(name => {
    const member = swarm.members.find(item => item.name === name);
    if (!member) throw new Error('Unknown swarm member: ' + name);
    if (member.cleaned) return [];
    if (member.stopped !== 'retired') throw new Error(`Member ${name} is still running or failed; retire it before cleaning its worktree`);
    if (!member.workspace) throw new Error(`Member ${name} has no managed worktree`);
    return [{ name, workspace: member.workspace }];
  });
}

/**
 * Releases the worktrees of retired members, one per name, so a long-running swarm does not keep every directory it
 * ever made against the workflow's workspace budget. Cleanup is the host operation behind the script's
 * `cleanupWorkspace`, and like it, it only removes a worktree that is idle and holds no unintegrated changes; the
 * members the script removed with its own key are reported as removed again rather than failing. `staffSwarm`
 * records the release in the change that marks the members cleaned. A failed member is not cleaned: reviving it runs
 * its turn in the same worktree, so retire it first if its worktree is no longer wanted.
 */
export async function staffCleanups(ctx: KernelContext, state: WorkflowView, input: Record<string, unknown>): Promise<Array<{ name: string; workspace: string }> | undefined> {
  if (input.cleanup === undefined) return undefined;
  if (!ctx.host.workspace) throw new Error('Workspace cleanup is unavailable in this workflow');
  if (state.parent) throw new Error('Workspace operations are unavailable in this workflow');
  if (state.status !== 'active' || state.script?.status !== 'running') throw new Error('Workflow is inactive');
  const latest = ctx.store.state(state.root.scopeId, state.workflowId) ?? state;
  const swarm = runningSwarm(latest, input.swarm);
  const pending = pendingCleanup(swarm, cleanupNames(swarm, input.cleanup));
  if (!pending.length) return [];
  const signal = new AbortController().signal;
  await Promise.all(pending.map(item => ctx.host.workspace!(ctx.store.public(latest),
    { kind: 'cleanup', key: `staff/cleanup/${swarm.id}/${item.name}`, workspace: item.workspace }, signal)));
  return pending;
}

/**
 * Changes to the staff of a running swarm, by the main agent or by the swarm's lead, so that staffing can follow
 * the work without a replay: more members, more wake-ups, failed members put back to work, members retired.
 * A new member runs with the execution binding of an existing one, or with `execution`: the binding the host resolved
 * for the harness and model the main agent named (see `staffSelection`), and in a worktree the host made for it
 * (see `staffWorkspaces`), so code written in parallel stays isolated. A lead cannot name harnesses or models, so a
 * member never reaches those beyond what the script and the main agent chose. Whether a queue gets a lead of its own
 * is likewise the main agent's decision: `leads` makes the one member it adds the lead of those queues.
 */
export function staffSwarm(state: WorkflowView, input: Record<string, unknown>, lead?: string, execution?: WorkerExecution, workspaces?: Record<string, string>, cleanedUp?: Array<{ name: string; workspace: string }>, now = Date.now()): unknown {
  if (Object.keys(input).some(key => !['swarm', 'add', 'like', 'workspace', 'queue', 'leads', 'role', 'brief', 'revive', 'retire', 'cleanup', 'maxTurns', 'maxConcurrent', ...EXECUTION_OPTIONS].includes(key))) throw new Error('staff_swarm supports swarm, add, like, workspace, harness, model, reasoningEffort, queue, leads, role, brief, revive, retire, cleanup, maxTurns and maxConcurrent');
  const workspaceWanted = input.workspace !== undefined && input.workspace !== false;
  if (workspaceWanted && input.add === undefined) throw new Error('workspace binds the members that add names');
  if (input.leads !== undefined && lead !== undefined) throw new Error('Only the main agent can give a queue a lead of its own');
  if (input.leads !== undefined && input.add === undefined) throw new Error('leads binds the member that add names');
  const chosen = EXECUTION_OPTIONS.some(option => input[option] !== undefined);
  if (chosen && lead !== undefined) throw new Error('Only the main agent can choose the harness or model of new members; a lead adds members like an existing one');
  if (chosen && !execution) throw new Error('The harness and model of the new members were not resolved');
  const swarm = lead === undefined ? runningSwarm(state, input.swarm) : leadSwarm(state, lead);
  if (input.add === undefined && input.revive === undefined && input.retire === undefined && input.cleanup === undefined && input.maxTurns === undefined && input.maxConcurrent === undefined) throw new Error('staff_swarm needs add, revive, retire, cleanup, maxTurns or maxConcurrent');
  const result: { swarm: string; added?: string[]; leads?: string[]; revived?: string[]; retired?: string[]; cleaned?: string[]; maxTurns?: number; maxConcurrent?: number; execution?: WorkerExecutionSelection; workspaces?: Array<{ name: string; workspace: string }> } = { swarm: swarm.key };
  if (input.maxConcurrent !== undefined) {
    // How many workers run at once is the budget the main agent started the workflow with, so only it changes it.
    if (lead !== undefined) throw new Error('Only the main agent can change maxConcurrent');
    if (state.parent) throw new Error('A child workflow runs within its root\'s concurrency; change the root workflow');
    const maxConcurrent = boundedInteger(input.maxConcurrent, state.definition.maxConcurrentWorkers, 1, MAX_CONCURRENT_WORKERS);
    if (maxConcurrent !== state.definition.maxConcurrentWorkers) emit(state, { type: 'concurrency_changed', maxConcurrentWorkers: maxConcurrent });
    result.maxConcurrent = maxConcurrent;
  }
  if (input.maxTurns !== undefined) {
    const maxTurns = boundedInteger(input.maxTurns, swarm.maxTurns, 1, SWARM_MAX_TURNS);
    if (maxTurns < swarm.maxTurns) throw new Error(`maxTurns can only be raised; it is ${swarm.maxTurns}`);
    if (maxTurns > swarm.maxTurns) emit(state, { type: 'swarm_turns_extended', swarmId: swarm.id, maxTurns });
    result.maxTurns = maxTurns;
  }
  if (input.revive !== undefined) {
    const failed = swarm.members.filter(member => member.stopped === 'failed');
    const names = input.revive === 'failed' ? failed.map(member => member.name)
      : Array.isArray(input.revive) ? input.revive.map(name => scriptText(name, 'member name', 100)) : undefined;
    if (!names) throw new Error('revive is "failed" or an array of member names');
    for (const name of names) {
      const member = swarm.members.find(item => item.name === name);
      if (!member) throw new Error('Unknown swarm member: ' + name);
      if (member.stopped !== 'failed') throw new Error(`Member ${name} has not failed`);
      const task = taskById(state, member.taskId);
      if (task && BUSY.has(task.status)) throw new Error(`Member ${name} is still stopping; try again shortly`);
      // Its last turn runs again in the same native session, as it would after a replay.
      if (task && task.status !== 'result_ready') {
        emit(state, { type: 'task_requeued', taskId: task.taskId, runId: state.script!.runId });
        // A turn that failed before a replay is not among the calls the swarm carried into this run. Left out, the
        // member's history would end one turn short of the turn it finishes, and it could not be woken again.
        if (!state.script!.calls.some(call => call.taskId === task.taskId)) emit(state, { type: 'script_call_recorded', call: { key: task.scriptKey!, taskId: task.taskId, cached: false } });
      }
      emit(state, { type: 'swarm_member_revived', swarmId: swarm.id, member: name });
    }
    result.revived = names;
  }
  if (input.retire !== undefined) {
    if (!Array.isArray(input.retire) || !input.retire.length) throw new Error('retire is an array of member names');
    const names = input.retire.map(name => scriptText(name, 'member name', 100));
    for (const name of names) {
      const member = swarm.members.find(item => item.name === name);
      if (!member) throw new Error('Unknown swarm member: ' + name);
      if (name === swarm.lead) throw new Error('The lead cannot be retired; it ends the swarm with swarm_finish');
      // The turn it is running finishes; it is not woken again.
      if (!member.stopped) emit(state, { type: 'swarm_member_stopped', swarmId: swarm.id, member: name, reason: 'retired' });
    }
    result.retired = names;
  }
  if (input.cleanup !== undefined) {
    const pending = pendingCleanup(swarm, cleanupNames(swarm, input.cleanup));
    const done = new Set(cleanedUp?.map(item => item.name) ?? []);
    const cleaned: string[] = [];
    for (const item of pending) {
      if (!done.has(item.name)) throw new Error('The worktrees of the named members were not cleaned up');
      emit(state, { type: 'swarm_member_workspace_cleaned', swarmId: swarm.id, member: item.name });
      cleaned.push(item.name);
    }
    result.cleaned = cleaned;
  }
  if (input.add !== undefined) {
    if (!Array.isArray(input.add) || !input.add.length || input.add.length > 64) throw new Error('add is an array of 1–64 new member names');
    const names = input.add.map(memberName);
    if (new Set(names).size !== names.length) throw new Error('Member names must be unique');
    if (swarm.members.length + names.length > SWARM_MAX_MEMBERS) throw new Error(`A swarm holds at most ${SWARM_MAX_MEMBERS} members, retired ones included`);
    const like = likeMember(swarm, input.like);
    const binding = chosen ? execution! : like.execution as WorkerExecution;
    const led = input.leads === undefined ? undefined : ledQueues(input.leads);
    if (led) {
      if (!swarm.lead) throw new Error('The lead of a queue reports to the swarm lead, and this swarm has none');
      if (names.length !== 1) throw new Error('leads makes one member the lead of its queues; add that member alone');
      if (input.queue !== undefined) throw new Error('A member that leads queues plans their work and does not consume a queue');
      const taken = led.find(name => queueLead(swarm, name));
      if (taken) throw new Error(`Queue "${taken}" already has a lead: ${queueLead(swarm, taken)!.name}`);
      for (const name of led) openQueue(state, name);
    }
    // A member that leads queues takes over the binding of the member it is added like, but neither its queue nor its role.
    const queue = led ? undefined : input.queue === undefined ? like.queue : queueName(input.queue);
    const brief = input.brief === undefined ? undefined : scriptText(input.brief, 'member brief', 4000);
    const described = input.role === undefined ? (led ? undefined : like.role) : role(input.role);
    if (workspaceWanted && like.workflowTool) throw new Error('Workspace v1 does not support nested workflow delegation');
    if (workspaceWanted && names.some(name => !workspaces?.[name])) throw new Error('The worktrees of the new members were not resolved');
    if (queue) openQueue(state, queue);
    for (const name of names) {
      if (nameTaken(state, name)) throw new Error('Member name is already used in this workflow: ' + name);
      const workspace = workspaceWanted ? workspaces![name] : undefined;
      emit(state, { type: 'swarm_member_added', swarmId: swarm.id, member: { name, execution: binding, turns: 0, added: true,
        ...(workspace ? { workspace } : {}),
        ...(described !== undefined ? { role: described } : {}), ...(brief !== undefined ? { brief } : {}), ...(like.workflowTool ? { workflowTool: true } : {}), ...(queue ? { queue } : {}),
        ...(led ? { leads: led } : {}) } });
    }
    if (led) {
      // The members already running were told who leads what in their first turn: the announcement brings them up to
      // date at their next one, and the post wakes the swarm's lead, which now has a part of the work to hand over.
      const text = `Member "${names[0]}" now leads ${led.length > 1 ? 'queues' : 'queue'} ${quoted(led)}: it adds their work, is handed the results of their items, and is told when one runs dry or one of its members fails. `
        + `Members that consume ${led.length > 1 ? 'these queues' : 'this queue'}: report blockers on that work to it. Lead: give it the goal of its part on the board and let it split the work.`;
      const head = swarm.lead;
      systemPost(state, { text, topic: BOARD_ANNOUNCE_TOPIC, ...(head && state.agents?.some(agent => agent.key === head) ? { to: [head] } : {}) }, now);
      result.leads = led;
    }
    result.added = names;
    if (workspaceWanted) result.workspaces = names.map(name => ({ name, workspace: workspaces![name]! }));
    if (chosen) result.execution = { agentKind: binding.agentKind, ...binding.modelSettings };
  }
  return result;
}

/**
 * A member's request to be woken after a delay. Members otherwise run only when a post names them or their queue has
 * work, so one that waits for a long job, or wants to look at something again later, had to hold its turn open.
 */
export function setMemberTimer(state: WorkflowView, caller: string, input: Record<string, unknown>, now: number): unknown {
  const swarm = ownerOf(state, caller);
  if (!swarm || swarm.status !== 'running' || swarm.runId !== state.script?.runId) throw new Error('wake_me is for the members of a running swarm');
  if (swarm.finish) throw new Error('Swarm is already finishing');
  const member = swarm.members.find(item => item.name === caller)!;
  if (input.afterMinutes === undefined) throw new Error('Give afterMinutes; 0 cancels the wake-up');
  const minutes = boundedInteger(input.afterMinutes, 0, 0, WAKE_MAX_MINUTES);
  if (!minutes) {
    if (member.wakeAt !== undefined) emit(state, { type: 'swarm_member_timer_set', swarmId: swarm.id, member: caller });
    return { wakeAt: null };
  }
  if (!coordinates(swarm, member) && member.turns >= swarm.maxTurns) throw new Error('You have no wake-ups left; report what remains on the board instead');
  const note = input.note === undefined ? undefined : scriptText(input.note, 'note', 500).trim() || undefined;
  const at = now + minutes * 60_000;
  emit(state, { type: 'swarm_member_timer_set', swarmId: swarm.id, member: caller, at, ...(note ? { note } : {}) });
  return { wakeAt: new Date(at).toISOString() };
}

/**
 * The lead that planned an item, which is who its outcome goes to: the lead that added it, else the lead of its queue,
 * else the swarm's lead. A lead otherwise hears only of what goes wrong (a failed member, a dry queue, an idle
 * swarm) and learns what its members produced by asking, so it plans the next work without the results of the last.
 * The outcomes a lead is owed (`handoffs`) wake it like a post that names it, gathered while members work, and reach
 * it as posts in topic "handoff" made when that turn is scheduled (see `handoffPost`): a post per item would give a
 * lead that is woken every ten minutes dozens of full results to read at once.
 */
function plannedBy(swarm: SwarmView, item: ItemView): MemberView | undefined {
  const author = swarm.members.find(member => member.name === item.by && !member.stopped);
  return (author && coordinates(swarm, author) ? author : undefined) ?? answersFor(swarm, item.queue ?? 'default');
}

/**
 * One post of the outcomes a lead is handed: by queue, what failed before what was completed. The items share
 * the room of the post, so the result of a single item is quoted at length and each of a dozen in a line.
 */
function handoffPost(entries: ReadonlyArray<{ item: ItemView; worker: string }>, total: number, later: number): string {
  const share = Math.floor(HANDOFF_POST_ROOM / entries.length);
  const queues = new Map<string, Array<{ item: ItemView; worker: string }>>();
  for (const entry of entries) { const name = entry.item.queue ?? 'default'; queues.set(name, [...queues.get(name) ?? [], entry]); }
  const lines = [`Outcomes of ${total === 1 ? 'a work item' : `${total} work items`} that came back since your last turn${total > entries.length ? `, ${entries.length} of them here` : ''}`
    + `${later ? `; ${later} more follow at your next turn` : ''}. work_status({key}) has an item in full.`];
  for (const [name, listed] of queues) {
    lines.push(`Queue "${name}":`);
    for (const { item, worker } of [...listed].sort((a, b) => Number(a.item.status === 'completed') - Number(b.item.status === 'completed'))) {
      const done = item.status === 'completed';
      const head = `- ${done ? 'completed' : 'failed'} "${item.key}" (${worker}): ${item.title.slice(0, entries.length > 4 ? 60 : 200)}`;
      const room = Math.min(HANDOFF_RESULT_CHARS, share - head.length - 12);
      const outcome = (done ? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result) ?? '') : item.error ?? '').trim();
      // A short quote is one line; a long one keeps the member's own line breaks.
      const quote = room < 400 ? outcome.replace(/\s+/g, ' ') : outcome;
      lines.push(head, ...(room >= 30 && quote ? [`  ${done ? 'Result' : 'Error'}: ` + (quote.length > room ? quote.slice(0, room) + '…[truncated]' : quote)] : []));
    }
  }
  return lines.join('\n').slice(0, 3990);
}

/**
 * What a member may do to work items: the swarm's lead plans every queue, the lead of a queue its own, and any member
 * may withdraw an item it added.
 */
export function workAuthority(state: WorkflowView, caller: string): WorkAuthority {
  const swarm = ownerOf(state, caller);
  const member = swarm?.members.find(item => item.name === caller);
  const runs = Boolean(swarm && member && !member.stopped && swarm.status === 'running' && swarm.runId === state.script?.runId);
  return item => runs && (swarm!.lead === caller || member!.leads?.includes(item.queue ?? 'default')) ? 'plans' : item.by === caller ? 'added' : undefined;
}

export function finishSwarm(state: WorkflowView, caller: string, input: Record<string, unknown>): unknown {
  const swarm = leadSwarm(state, caller);
  emit(state, { type: 'swarm_finish_requested', swarmId: swarm.id, result: scriptText(input.result, 'swarm result', 16_000) });
  return { finishing: true };
}

function memberSummary(state: WorkflowView, swarm: SwarmView, member: MemberView) {
  const task = taskById(state, member.taskId);
  const status = member.stopped ?? (task && BUSY.has(task.status) ? 'running' : swarm.status === 'running' ? 'waiting' : !coordinates(swarm, member) && member.turns >= swarm.maxTurns ? 'max_turns' : 'idle');
  const usual = likeMember(swarm, undefined).execution;
  const model = member.execution.modelSettings.model;
  return { name: member.name, ...(member.name === swarm.lead ? { lead: true } : {}), ...(member.leads?.length ? { leads: member.leads } : {}), ...(member.queue ? { queue: member.queue } : {}), ...(member.added ? { added: true } : {}), ...(member.cleaned ? { cleaned: true } : {}),
    // Only the members bound unlike the rest carry their binding, which keeps a large swarm's summary short.
    ...(member.execution.agentKind !== usual.agentKind ? { harness: member.execution.agentKind } : {}),
    ...(model && (model !== usual.modelSettings.model || member.execution.agentKind !== usual.agentKind) ? { model } : {}), turns: member.turns, status,
    ...(member.itemsDone ? { itemsDone: member.itemsDone } : {}), ...(member.itemsFailed ? { itemsFailed: member.itemsFailed } : {}),
    ...(member.wakeAt !== undefined ? { wakeAt: member.wakeAt } : {}), ...(member.detail ? { error: member.detail } : {}) };
}

/**
 * Supply and demand of each queue the swarm consumes: how many of its pending items can be claimed now and how many
 * wait on something, against the members that are working and the ones with nothing to do. With the time, also how
 * the queue has moved: what entered and left it in each of the last hours (`flow`), and how often and for how long
 * its members sat idle with nothing to claim (`dry`).
 */
function queueSummary(state: WorkflowView, swarm: SwarmView, now?: number): Record<string, unknown> | undefined {
  const names = [...new Set(swarm.members.flatMap(member => member.queue && !member.stopped ? [member.queue] : []))];
  if (!names.length) return undefined;
  return Object.fromEntries(names.map(name => {
    const items = (state.workQueue?.items ?? []).filter(item => (item.queue ?? 'default') === name);
    const claimable = availableWork(state, name).length;
    const members = swarm.members.filter(member => member.queue === name && !member.stopped);
    const running = members.filter(member => { const task = taskById(state, member.taskId); return Boolean(task && BUSY.has(task.status)); }).length;
    const own = queueLead(swarm, name);
    const onHold = items.filter(item => item.status === 'pending' && item.hold).length;
    const flow = now === undefined ? undefined : workFlow(state, name, now);
    const dry = swarm.dry?.[name];
    const minutes = (ms: number) => Math.round(ms / 6000) / 10;
    return [name, { ...(own ? { lead: own.name } : {}), claimable, blocked: items.filter(item => item.status === 'pending').length - claimable, ...(onHold ? { onHold } : {}), claimed: items.filter(item => item.status === 'claimed').length,
      members: members.length, running, idle: members.length - running, ...(swarm.starved?.[name] ? { starvedSince: swarm.starved[name]!.since } : {}),
      ...(flow ? { flow } : {}), ...(dry ? { dry: { spells: dry.spells, minutes: minutes(dry.ms), longestMinutes: minutes(dry.longest) } } : {}) }];
  }));
}

export function swarmSummary(state: WorkflowView, swarm: SwarmView, now?: number): unknown {
  const queues = swarm.status === 'running' ? queueSummary(state, swarm, now) : undefined;
  return { key: swarm.key, status: swarm.status, stop: swarm.stop, reason: swarm.reason, lead: swarm.lead, maxTurns: swarm.maxTurns, turns: turnCount(swarm),
    posts: boardTotal(state) - swarm.firstPost + 1, ...(queues ? { queues } : {}), members: swarm.members.map(member => memberSummary(state, swarm, member)) };
}

/** What `swarm()` resolves to once the swarm has ended; undefined while it runs. */
export function swarmResult(state: WorkflowView, key: string): unknown | undefined {
  const swarm = state.swarms?.find(item => item.key === key);
  if (!swarm) throw new Error('Unknown swarm');
  if (swarm.status === 'running') return undefined;
  if (swarm.stop === 'failed' && swarm.reason) throw new Error(swarm.reason);
  const board = readBoard(state, { after: swarm.firstPost - 1, limit: 50, upTo: swarm.lastPost });
  const queues = [...new Set(swarm.members.flatMap(member => member.queue ? [member.queue] : []))];
  // The whole result must fit a script value, so a large swarm gets shorter notes.
  const noteChars = Math.min(2000, Math.floor(40_000 / swarm.members.length));
  return { stop: swarm.stop, ...(swarm.finish ? { result: swarm.finish.result } : {}), turns: turnCount(swarm),
    members: swarm.members.map(member => {
      const latest = [...swarm.turns].reverse().map(turn => taskById(state, turn.taskId)).find(task => task?.status === 'result_ready' && state.agents?.find(agent => agent.agentId === task.agentId)?.key === member.name);
      const ref = latest?.resultRefs.at(-1);
      return { ...memberSummary(state, swarm, member), note: ref ? readArtifact(state, ref).text.slice(0, noteChars) : null };
    }),
    ...(queues.length ? { queues: Object.fromEntries(queues.map(name => [name, workStatus(state, { queue: name })])) } : {}),
    posts: board.posts, lastSeq: board.lastSeq, hasMore: board.hasMore };
}
