import { BOARD_ANNOUNCE_TOPIC, BOARD_NOTICED_TOPIC } from './limits';
import { answersFor, coordinates, leadsAbove, quoted, superior, type ItemView, type MemberView, type SwarmView } from './swarm';
import type { Situation } from './todos';
import type { Immutable, WorkflowTodo, WorkflowView } from './types';

/**
 * What a swarm member is told: the rules of its part once, in its first turn, and a brief at the start of every turn.
 *
 * The rules say how to do the part well. How the swarm is run is not in them: what waits on a member, what it can
 * claim and what has changed are worked out for each turn and put in the brief, so a member needs no account of the
 * ways it might be told of things, and what it reads is how things stand now.
 */

/** A lead's own wake-up, and every few of the others, is its review of the plan, which starts from the goal instead of from what came back. */
const REVIEW_EVERY_TURNS = 8;
/** To-dos, open asks and new rulings a brief lists in full; it counts the rest. */
const TODOS_SHOWN = 12;
const ASKED_SHOWN = 6;
const RULINGS_SHOWN = 5;
const RULING_CHARS = 600;
/** The room the outcomes of items share in a brief: one is quoted at length, a dozen get a line or two each. */
const RESULTS_ROOM = 3600;
const RESULT_CHARS = 1500;

const PLAN_ONLY = 'You plan and judge; you do not do the work: no code, builds, tests or measurements of your own, except to check a result before you rely on it';

/** What both parts are told about turns, to-dos and speaking to each other. */
function common(swarm: SwarmView, member: MemberView, above: string): string[] {
  const lead = coordinates(swarm, member);
  return [
    'How it works:',
    '- Every turn starts with a brief: what waits on you, what you can claim and what has changed. Your turn ends with your final answer, a one-line status note. You then sleep at no cost and are woken when '
      + (lead ? 'something waits on you, results have gathered' : member.queue ? 'something waits on you, your queue has work you can claim' : 'something waits on you') + ' or a wake-up you set with wake_me is due.'
      + (lead ? '' : ` After this first turn you can be woken at most ${swarm.maxTurns} times.`),
    '- A to-do is something that waits on you: an ask, or a state of things you answer for. It is in every brief until its cause is gone (do what it takes and it goes by itself), '
      + 'or you say "not now" with defer_todo({id, note, minutes?}), or hand it on with pass_todo({id, to}). One you leave open goes to whoever stands above you: ' + above + '.',
    '- To get an answer or have something done, ask: ask({to, text}) is a to-do of that member until it answers, and brings you the answer. '
      + (above.startsWith('the main agent') ? 'Ask the main agent with to: "main". ' : '')
      + 'Answer what is asked of you with answer({ask, text}) before other work; when you cannot yet, answer with what it waits on. '
      + 'A note (note({text, topic})) tells without asking and wakes nobody: use it for what is worth knowing, and do not ask for what a note would do. Post no acknowledgements.',
    '- Save a checkpoint of your working state before you end a turn. To wait for a long build, test or job, set wake_me and end the turn; do not poll or sleep in a turn.',
  ];
}

/**
 * The rules of a lead: the lead of the swarm for the whole task, any other lead for its part of it. A lead that other
 * leads answer to reads the same rules: what differs between the levels is only who stands above and who below.
 */
function leadRules(swarm: SwarmView, member: MemberView): string[] {
  const whole = member.name === swarm.lead;
  const led = member.leads ?? [];
  const boss = superior(swarm, member)?.name ?? swarm.lead;
  const delegates = swarm.members.filter(item => !item.stopped && item.leads?.length && superior(swarm, item) === member);
  const part = whole ? 'the goal' : 'your part';
  return [
    whole ? '- You are the lead. You turn the goal into work for the members, judge what comes back, deal with what waits on you and decide when the swarm is done.'
      : `- You lead ${led.length > 1 ? 'queues' : 'queue'} ${quoted(led)} under @${boss}: that part of the task is yours to plan, its results are yours to judge, and what waits in it waits on you. `
        + `What your part must deliver is in the status of @${boss}: plan toward that, and when you think it is the wrong thing to deliver, ask @${boss} instead of planning toward something else.`,
    `- ${PLAN_ONLY}: every piece of work goes into a queue as an item.`,
    '- The goal, and the test that tells when it is met, are the user\'s: only the main agent changes them. What you keep current is your status (set_status): '
      + `how far off ${part} is now by that test, what is being tried, what was ruled out (with where the evidence is, so that nobody tries it again), what is not known yet that would change the plan`
      + (delegates.length ? ', the priorities, and what each part that has a lead of its own must deliver. ' : ' and the priorities. ')
      + `${whole ? 'Every member' : 'Every member that works under you'} is given it at every turn and updating it wakes nobody, so write it when it changes; keep it short. `
      + `When results show that ${part} cannot be met as stated, or is not what is wanted, say so in your status and ask ${whole ? 'the main agent' : '@' + boss} instead of planning toward something else.`,
    `- Hand out work with enqueue_work${whole ? '' : ', naming the queue'}. An item is one result that a single member can finish and check in one turn: what is wanted, where, the check that tells done from not done, and which part of the goal it moves. `
      + 'With that last line the member can tell when the item as written will not get there. Where the member that finds an answer can act on it, ask for both in one item. '
      + 'Split what is larger, and what two members could not do at once without touching the same files: name the paths an item will change in writes, and order the items that the answer lists as writeOverlaps with dependsOn. '
      + 'assignee gives an item to one member; origin, the key of a delivered item, sends what is about that item to the member that delivered it.',
    '- The goal needs two kinds of work. One is a step of the goal itself. The other is what you do not know yet: a question whose answer would change the plan, a way nobody has tried, something the plan takes for granted and nobody has checked. '
      + 'Such an item names the question, what will be done differently for each answer and how much effort it is worth; "this does not work, and this is why" completes it. '
      + 'Keep some members on the second kind while the goal is not met, more of them when it has stopped coming closer. Do not add an item whose result would change nothing whichever way it comes out.',
    '- Members finish items faster than you are woken, so plan ahead of them. But idle members are not a reason to add work: an item that does not move the goal costs a member a turn and you the reading of its result. '
      + 'A queue that is empty while the goal is not met says that the plan does not reach the goal: ask what still lies between where things stand and the goal, and what you would have to know to close it. '
      + 'Where that leaves nothing its members could do, leave the queue empty and defer the to-do that tells you of it'
      + (whole ? ', or move its members to a queue with more work than members (staff_swarm).' : `, and say so in your status, which @${boss} reads.`),
    '- Results come back in your brief, a line or two each, gathered while members work; work_status({key}) has one in full. Judge them on evidence (test output, measurements, sources), '
      + 'by how far the goal has moved and not by how many came back. A result suggests more next steps than the goal needs: add what closes the distance, not everything it suggests.',
    '- Work is delivered as soon as the check its item names passes; do not make each result wait for a reviewer. Finding what is wrong with delivered work is work you plan, for members that did not produce it: '
      + 'items that try what was delivered (run it, use it as its users would, redo the step a conclusion rests on). Do not plan a review of a report or a check of another check. '
      + 'What is found comes back as a new item with origin, the key of the item it was found in. Only where a mistake would spread before anyone finds it (a default or a switch, a number other work builds on, the checks themselves) have the result checked before it is delivered.',
    '- An item that must wait names what it waits for in dependsOn: another item, or a gate (enqueue_work with gate: true), a condition that settle_work declares met; it is then handed out without you. '
      + 'When the plan changes, amend an item nobody has claimed (update_work with title, input), replace one that is claimed or done (supersededBy, or enqueue_work with supersedes), and cancel what no longer serves the goal; do not re-issue work under new keys. '
      + 'hold: true, with a reason, is only for what you set aside by decision; you answer for it until you return it.',
    `- Members note in topic "${BOARD_NOTICED_TOPIC}" what they saw that the plan does not account for. Read it when you review, turn what bears on the goal into items, and mark what you dealt with (resolve_post).`,
    '- tell_worker puts your words into the running turn of a member' + (whole ? '' : ' that works under you') + ' when work in flight must change now. '
      + (whole ? `A ruling that every member must follow is a note in topic "${BOARD_ANNOUNCE_TOPIC}": members get the new ones in their brief.` : `Rulings for everyone are made by @${swarm.lead}.`),
    ...(delegates.length ? [`- These members lead parts of the work under you: ${delegates.map(item => `${item.name} (${item.leads!.length > 1 ? 'queues' : 'queue'} ${quoted(item.leads!)})`).join(', ')}. `
      + 'Say in your status what each part must deliver and how to tell, and let its lead split that into items; add an item to such a queue yourself only when its result should come back to you. '
      + 'What one of them leaves open comes to you.'] : []),
    ...(whole ? ['- Idle members and an empty queue do not mean the task is done. The swarm ends only when you call swarm_finish with the final result: do so once the goal is met or cannot progress, and say which and what remains. '
      + 'staff_swarm adds members, moves them between queues, retires them and revives failed ones.']
      : [`- @${swarm.lead} decides when the swarm is done and changes its staff. Say in your status, which @${boss} reads, how far your part has come, what blocks it and what it needs from the other parts.`]),
    `- Your review of ${whole ? 'the plan' : 'your part'} is the wake-up you set with wake_me and every ${REVIEW_EVERY_TURNS}th turn: it starts from ${part} instead of from what came back, and its brief gives the steps. Set wake_me before you end a turn while work is in flight.`,
  ];
}

/** The rules of a member of a swarm without a lead that consumes no queue: its work is the task itself. */
function peerRules(): string[] {
  return [
    '- You work on the task side by side with the other members, each in its own role; nobody hands out the work. Do your part of the task in this turn, and check it before you call it done.',
    '- When you need something from another member (a result, a check, a decision), ask it: it is woken for your ask, and you for its answer. What you found that the others should know goes in a note, which they read at their next turn.',
    '- The final answer of each turn is your result so far: start with the conclusion, then what you did, what you found and what still worries you. The swarm is over once every member has gone quiet.',
  ];
}

/** The rules of a member that does the work of a queue. */
function workerRules(swarm: SwarmView, member: MemberView): string[] {
  if (!member.queue) return peerRules();
  const planner = answersFor(swarm, member.queue)?.name;
  return [
    `- You do the work of queue "${member.queue}". claim_work takes an item: read item.progress before you act, save checkpoint_work as you go, then complete_work or fail_work. Go on until claim_work returns null, then end the turn; do not wait for work.`,
    '- Do what the item asks and check it the way the item says before complete_work. Where it asks for something to be made or changed, a description of how that could be done does not complete it. '
      + 'Work that is not finished is not complete: fail_work with what blocks you (retry: true only when another attempt could succeed), save checkpoint_work and go on in your next turn, '
      + 'or hand it back with release_claim({reason, waitFor: [keys]}) when it has to wait for other items. '
      + 'When you find that it should not be done, or that what it expects is not so, complete it with that finding and its evidence, and say plainly that nothing was changed.',
    '- An item is there for a part of the goal, which it names; that is what you are after, not the wording. When the item as written will not get it, or you see a clearly better way within what the item touches, '
      + 'take that way and say in the result where you departed from the item and why. When the better way reaches beyond the item, do not take it yourself: finish or fail the item and say what you saw.',
    '- Deliver as soon as the check passes: nobody reviews each item before it counts, and what others later find wrong with it comes back as new work. '
      + 'Do not weaken a test, special-case an input or change an expected output to make a check pass: a check you cannot pass honestly is a blocker, so fail_work and say why.',
    '- The result you give complete_work is your report' + (planner ? `, which @${planner} reads` : '') + ': start with the conclusion, then what you did, what you found, where you departed from the item and what still worries you. '
      + 'Write no account of your work beside it (a report, a summary, a log) unless the item names that document; long output belongs where the task keeps such files, with the path in the result.',
    '- What you find outside your item is new work, not yours to do: look for it with search_work, and if nobody has reported it add it with enqueue_work (for a fault in what was delivered, give origin, the key of that item, and how to see the fault for oneself). '
      + 'That holds most of all for what everyone depends on (the shared branch, a build, a tool): report it once and leave the repair to whoever is given it.'
      + (swarm.lead ? ` What you see that the plan does not account for (something it takes for granted that is not so, a cause behind several items, a shorter way to the goal, a way that cannot work) goes in note({topic: "${BOARD_NOTICED_TOPIC}", text}): `
        + 'what you saw, how to see it for oneself and what it could change. Search that topic first; most items leave nothing to note.' : ''),
    ...(planner ? [`- @${planner} ${planner === swarm.lead ? 'is the lead' : 'leads your queue'}: it plans the work and judges the results. Ask it when you cannot or should not go on without an answer.`] : []),
  ];
}

/** Who stands above a member, in the order a to-do it leaves open travels. */
function aboveText(state: WorkflowView, swarm: SwarmView, member: MemberView): string {
  const names = leadsAbove(state, member.name);
  return [...names.map((name, index) => `@${name}${name === swarm.lead ? ' (lead of the swarm)' : index === 0 && member.queue ? ' (lead of your queue)' : ''}`), 'the main agent'].join(', then ');
}

function rules(state: WorkflowView, swarm: SwarmView, member: MemberView): string {
  return ['Your part:', ...(coordinates(swarm, member) ? leadRules(swarm, member) : workerRules(swarm, member)), ...common(swarm, member, aboveText(state, swarm, member))].join('\n');
}

/** The members as a member is shown them: those with the same standing, queue and role share a line. */
function roster(swarm: SwarmView): string {
  const lines = new Map<string, string[]>();
  for (const item of swarm.members) {
    if (item.stopped) continue;
    const above = item.leads?.length ? superior(swarm, item) : undefined;
    const standing = (item.name === swarm.lead ? ' (lead)' : item.leads?.length ? ` (leads ${quoted(item.leads)}${above && above.name !== swarm.lead ? ' under @' + above.name : ''})` : item.queue ? ` (queue "${item.queue}")` : '') + (item.role ? ' — ' + item.role : '');
    lines.set(standing, [...lines.get(standing) ?? [], '@' + item.name]);
  }
  return [...lines].map(([standing, names]) => names.join(', ') + standing).join('\n');
}

/** What a turn is told of how things stand for its member; everything in it is worked out when the turn is scheduled. */
export interface BriefFacts {
  now: number;
  /** The wake-up the member set with wake_me is due. */
  timed?: boolean;
  /** What waits on the member, the oldest first, and how many it has deferred. */
  todos: ReadonlyArray<{ todo: Immutable<WorkflowTodo>; situation: Situation }>;
  deferred: number;
  /** The asks of its own that are still open. */
  asked: ReadonlyArray<{ seq: number; to: string; minutes: number; text: string }>;
  /** A worker: the items of its queue it can claim now, and how many of those are kept for it. */
  claimable: number;
  own: number;
  /** A lead: the outcomes that came back since its last turn, how many more wait for its next, and how its queues stand. */
  results: ReadonlyArray<{ item: ItemView; worker: string }>;
  moreResults: number;
  queues?: string;
  /** Rulings made since the member's last turn, and how many more there are. */
  rulings: ReadonlyArray<{ seq: number; from: string; text: string }>;
  moreRulings: number;
  /** A lead: notes in topic "noticed" that are new since its last turn. */
  noticed: number;
}

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** The lines of a brief that say what waits on the member. */
function todoLines(facts: BriefFacts, me: string): string[] {
  if (!facts.todos.length) return facts.deferred ? [`Nothing waits on you now; ${facts.deferred} to-do${facts.deferred > 1 ? 's' : ''} you deferred ${facts.deferred > 1 ? 'are' : 'is'} still open (read_context lists them).`] : [];
  const shown = facts.todos.slice(0, TODOS_SHOWN);
  return [`${facts.todos.length} to-do${facts.todos.length > 1 ? 's wait' : ' waits'} on you${facts.deferred ? ` (and ${facts.deferred} you deferred)` : ''}; deal with ${facts.todos.length > 1 ? 'them' : 'it'} before other work:`,
    ...shown.map(({ todo, situation }) => {
      const last = todo.told.at(-1)!;
      const before = [...new Set(todo.told.slice(0, -1).map(told => told.who).filter(who => who !== me))];
      const how = last.who !== me ? `, now also with ${last.who === 'main' ? 'the main agent' : last.who}` : last.by && last.by !== me ? `, handed to you by ${last.by}${last.note ? ': ' + last.note : ''}` : before.length ? `, left open by ${before.join(', ')}` : '';
      const said = me === situation.chain[0] && situation.first ? situation.first : situation;
      return `- #${todo.id} (${minutes(facts.now - todo.since)} min${how}) ${said.en} Do: ${said.act}`;
    }),
    ...(facts.todos.length > shown.length ? [`- and ${facts.todos.length - shown.length} more: read_context lists them`] : [])];
}

/**
 * The outcomes a lead is handed, by queue, what failed before what was completed. The items share the room, so the
 * result of a single item is quoted at length and each of a dozen in a line.
 */
function resultLines(entries: BriefFacts['results'], later: number): string[] {
  if (!entries.length) return [];
  const share = Math.floor(RESULTS_ROOM / entries.length);
  const failed = entries.filter(entry => entry.item.status !== 'completed').length;
  const queues = new Map<string, Array<{ item: ItemView; worker: string }>>();
  for (const entry of entries) { const name = entry.item.queue ?? 'default'; queues.set(name, [...queues.get(name) ?? [], entry]); }
  const lines = [`${entries.length} result${entries.length > 1 ? 's' : ''} came back since your last turn (${entries.length - failed} completed, ${failed} failed)`
    + `${later ? `; ${later} more follow at your next turn` : ''}. work_status({key}) has one in full.`];
  for (const [name, listed] of queues) {
    if (queues.size > 1) lines.push(`Queue "${name}":`);
    for (const { item, worker } of [...listed].sort((a, b) => Number(a.item.status === 'completed') - Number(b.item.status === 'completed'))) {
      const done = item.status === 'completed';
      const head = `- ${done ? 'completed' : 'failed'} "${item.key}" (${worker}): ${item.title.slice(0, entries.length > 4 ? 60 : 200)}`;
      const room = Math.min(RESULT_CHARS, share - head.length - 12);
      const outcome = (done ? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result) ?? '') : item.error ?? '').trim();
      // A short quote is one line; a long one keeps the member's own line breaks.
      const quote = room < 400 ? outcome.replace(/\s+/g, ' ') : outcome;
      lines.push(head, ...(room >= 30 && quote ? [`  ${done ? 'Result' : 'Error'}: ` + (quote.length > room ? quote.slice(0, room) + '…[truncated]' : quote)] : []));
    }
  }
  return lines;
}

/** The steps of a lead's review, which begins at the goal: the whole of it for the swarm's lead, its part for the lead of a queue. */
function reviewSteps(swarm: SwarmView, member: MemberView): string {
  const whole = member.name === swarm.lead;
  return `This turn is your review of ${whole ? 'the plan' : 'your part'}: start from ${whole ? 'the goal' : 'what your part must deliver'}, not from what came back. `
    + (whole ? '(1) Read the goal and its test, ' : `(1) Read what your part must deliver, in the status of @${superior(swarm, member)?.name ?? swarm.lead}, `)
    + 'and work out how far off it is now by that test and what has moved it since your last review, on evidence. '
    + `(2) For what each ${whole ? 'queue' : 'of your queues'} is working on, ask which part of that distance it closes, and cancel or amend what closes none (update_work). `
    + '(3) Name the largest part of the distance that is left: is anything in the queues aimed at it, and what is not known about it? '
    + `(4) Read topic "${BOARD_NOTICED_TOPIC}" for what members saw that the plan does not account for. `
    + '(5) Rewrite your status (set_status): how things stand now, what is being tried and what was ruled out. '
    + `When two reviews in a row find ${whole ? 'the goal' : 'your part'} no closer, the plan is what is wrong: stop adding work of the kind you have been adding, `
    + `and put members on finding out why and on other ways ${whole ? 'to the goal' : 'to deliver it'}.`;
}

/** How things stand for a member at the start of a turn. The same lines open its first turn, below the rules. */
function standing(swarm: SwarmView, member: MemberView, facts: BriefFacts, opening: boolean): string[] {
  const lead = coordinates(swarm, member);
  const whole = member.name === swarm.lead;
  const review = lead && !opening && (facts.timed || (member.turns + 1) % REVIEW_EVERY_TURNS === 0);
  return [
    ...(facts.timed ? [`The wake-up you set with wake_me is due${member.wakeNote ? ': ' + member.wakeNote : ''}.`] : []),
    // A member that was moved was told its queue, and perhaps its role, in a turn that spoke of another queue.
    ...(member.queue && member.movedFrom && member.movedFrom !== member.queue ? [`You have been moved from queue "${member.movedFrom}" to queue "${member.queue}"`
      + (answersFor(swarm, member.queue) ? `, which @${answersFor(swarm, member.queue)!.name} leads` : '') + `: where your first turn speaks of "${member.movedFrom}", the items of "${member.queue}" now say what is wanted.`
      + (member.role ? ` Your role now: ${member.role}${/[.!?。]$/.test(member.role) ? '' : '.'}` : '')] : []),
    ...todoLines(facts, member.name),
    ...(facts.asked.length ? [`Your open asks: ${facts.asked.slice(0, ASKED_SHOWN).map(ask => `${ask.seq} to ${ask.to} (${ask.minutes} min)`).join(', ')}`
      + `${facts.asked.length > ASKED_SHOWN ? ` and ${facts.asked.length - ASKED_SHOWN} more` : ''}. The answers arrive by themselves; answer({ask, text}) on your own ask withdraws it.`] : []),
    ...(facts.rulings.length ? [`New rulings, which bind you:`, ...facts.rulings.slice(0, RULINGS_SHOWN).map(ruling => `- (${ruling.from}, post ${ruling.seq}) ${ruling.text.length > RULING_CHARS ? ruling.text.slice(0, RULING_CHARS) + '…[read_board has the rest]' : ruling.text}`),
      ...(facts.moreRulings ? [`- and ${facts.moreRulings} more: read_board({topic: "${BOARD_ANNOUNCE_TOPIC}"})`] : [])] : []),
    ...resultLines(facts.results, facts.moreResults),
    ...(lead && facts.queues ? [`Queues now: ${facts.queues}.`] : []),
    ...(lead && facts.noticed ? [`${facts.noticed} new note${facts.noticed > 1 ? 's' : ''} in topic "${BOARD_NOTICED_TOPIC}".`] : []),
    ...(review ? [reviewSteps(swarm, member)] : []),
    ...(lead && !review && !opening ? ['Judge what came back by how far the goal has moved, then leave each queue'
      + (swarm.members.some(item => !item.stopped && item.leads?.length && superior(swarm, item) === member) ? ' that has no lead of its own' : whole ? '' : ' of yours')
      + ' with the work the goal still needs, what you know and what has to be found out. Idle members are not a reason to add items.'] : []),
    ...(member.queue ? [facts.claimable ? `Queue "${member.queue}" has ${facts.claimable} item${facts.claimable > 1 ? 's' : ''} you can claim`
      + (facts.own ? `, ${facts.own} of them kept for you (claim_work hands those out first; item.origin names the delivered item one is about)` : '') + ': take them with claim_work until it returns null.'
      : `Queue "${member.queue}" has nothing you can claim now.`] : []),
  ];
}

/** The prompt of a member's first turn: who it is, the task, the others, the rules of its part and how things stand. */
export function openingPrompt(state: WorkflowView, swarm: SwarmView, member: MemberView, facts: BriefFacts): string {
  const lead = coordinates(swarm, member);
  return [`You are member "${member.name}" of swarm "${swarm.key}".` + (member.role ? '\nYour role: ' + member.role : ''),
    'Task:\n' + swarm.task,
    ...(member.brief ? ['You were added while the swarm was running, with this brief:\n' + member.brief] : []),
    'Members:\n' + roster(swarm),
    rules(state, swarm, member),
    'This is your first turn.',
    ...standing(swarm, member, facts, true),
    lead ? (member.name === swarm.lead ? 'Start now: write your status, then hand out the first work.' : 'Start now: read what your part must deliver, write your status, then hand out the first work of your queues.')
      : 'Start on the work now.',
  ].join('\n');
}

/** The prompt of every later turn. */
export function turnBrief(state: WorkflowView, swarm: SwarmView, member: MemberView, facts: BriefFacts): string {
  const lead = coordinates(swarm, member);
  const who = member.name === swarm.lead ? 'the lead' : member.leads?.length ? `lead of ${member.leads.length > 1 ? 'queues' : 'queue'} ${quoted(member.leads)}` : member.queue ? `a worker of queue "${member.queue}"` : 'a member';
  return [`Swarm "${swarm.key}", wake-up ${member.turns + 1}${lead ? '' : ' of at most ' + swarm.maxTurns}. You are ${member.name}, ${who}; above you: ${aboveText(state, swarm, member)}.`,
    ...standing(swarm, member, facts, false),
    'End the turn with a one-line status note.'].join('\n');
}
