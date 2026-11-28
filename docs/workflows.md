# Workflows

Workflows are script-driven. The bridge owns scheduling, task state, worker sessions and final result notifications; the main agent writes and reviews the script. Both the main agent and each worker can select a harness **and** a model. Configured Codex, Claude and Pi backends can be mixed in one workflow, and multiple workers can use different models under the same harness.

## Invoke from Lark

First set the main agent in the target chat/topic:

1. Use `/config run` to choose the bot-wide default execution engine (Codex, Claude or Pi); this affects all its DMs, groups and topics.
2. Send `/model <model ID>` and optionally `/effort <level>` for the main model and reasoning effort. `/model` without arguments opens the selection card. A configured service can be selected with `<provider>/<model>`.
3. Start the workflow, giving the task and worker selections in natural language:

```text
/workflow start 架构评审：Pi 使用 <方案模型> 提出方案，Claude 使用 <替代模型> 提出独立方案，Codex 使用 <审查模型> 审查并汇总。需求：……
```

Replace bracketed placeholders with models supported by the configured harness/provider. In groups, genuinely mention the bot when required by the chat settings. The bot writes a concrete execution plan and script, publishes the plan before starting workers, then returns the reviewed result to the same chat/topic. You do not need to write JavaScript in Lark.

Workflows start only through `/workflow start` or `/workflow script`. The bridge command handler marks the queued request, and only that route receives permission to create a workflow. Ordinary message turns use the main agent directly and receive neither workflow instructions nor workflow credentials, even when a workflow exists in the topic. Natural-language mentions, quotations and task types do not switch modes. Internal completion events receive a continuation binding restricted to the existing workflow; they cannot create a new one. The API checks the caller's bridge-issued start permission independently of prompt text or request parameters.

The bridge selects a typed agent entry before preparing a turn: `direct` for ordinary messages, or `workflow` with a command/event trigger. The queue preserves this entry across restart and keeps command turns separate from ordinary message batches. Entry handlers prepare their own instructions, credentials and lifecycle callbacks, then share the existing session, agent-execution and output layers. Additional entry types can extend this boundary; only direct and workflow entries are implemented today.

Use `/workflow help` for the built-in command reference and a startup example; it is available before starting a workflow and does not launch an agent. `/workflow script <task>` remains an alias for the same script entry. It is not a separate engine. Use `/workflow plan` to see the saved execution plan (stages, assignments, selected models, dependencies and conditional branches), and `/workflow status [member]` to inspect execution and recovery progress. Both commands show the most recent workflow after completion/cancellation. Use `/workflow pause` and `/workflow resume` to pause/replay, and `/workflow cancel` or `/stop` to cancel. Choose the root session, engine and workspace before starting: changing them invalidates the existing binding. Changing the main model or reasoning effort (`/model`, `/effort`, `/config run`) does not; the main agent uses the new settings on its next turn, while workers keep the defaults pinned when the workflow started.

In Lark, after the plan the bridge posts one progress card to the same chat/topic and edits it in place: status and script phase, turn counts (completed, running, waiting for a slot, queued, failed), elapsed time and deadline, work-queue counts, up to eight active tasks with their timings, the three latest failures and script log lines. Edits are coalesced to at most one every five seconds, and running workflows refresh once a minute so timings stay current; a paused or interrupted card is not rewritten until something changes. The card turns green, grey or red on completion, cancellation or failure and stops updating once the workflow is completed or cancelled. Its message and CardKit IDs are kept in `workflow-progress-cards.json` beside the workflow database, so a bridge restart continues the same card. Child workflows appear as the parent task waiting for them. The card is a summary; `/workflow status` keeps the full diagnostics.

Status shows each member's current turn and attempt count, actual execution state, receive batch, latest checkpoint version/time, and a bounded diagnostic reason when execution fails. `status A` also shows member A's task objective, unacknowledged message count and six most recent turns. Waiting for a message, reserving it for a turn, and acknowledging it after successful completion are shown separately. Checkpoint state and message bodies are not included in these summaries. General status prioritizes members/tasks that need attention and limits expanded entries; long text is shortened and credential patterns in errors are redacted. Status is read-only: inspecting a paused/interrupted workflow or queuing messages does not replay it. Follow the displayed recovery hint after resolving the cause.

Each attempt records `startedAt` (queued by the engine), `admittedAt` (the bridge process pool granted a slot), `spawnedAt` (native process started), `sessionAt` (native session reported) and `endedAt`. Workflow workers share the bot's process pool with chat runs at background priority, which may use at most `max_concurrent_runs - 1` slots, and a waiting worker still counts toward `maxConcurrent`. Status therefore shows tasks without a slot as "等待执行槽位", per-attempt slot wait and execution time, and the workflow's cumulative slot wait. Events record `createdAt`, `notifiedAt` and `acknowledgedAt`; status shows how long the oldest unacknowledged event has waited. Records created before this tracking have no such fields and are omitted from these figures.

The old `architecture-review` plugin and agent-led `start`, `delegate`, `send`, `begin_revision_round` API operations have been removed. When explicitly requested, a workflow can perform architecture review as an ordinary script use case; there is no fixed designer/challenger plugin. On upgrade, unfinished old instances are cancelled and release their topic binding. Their existing artifacts remain readable by workflow ID, but old instances cannot resume. The packaged review example demonstrates independent proposals and a conditional revision through this common API.

### What agents are told

What the main agent is told depends on what the turn is for, because the text of every turn stays in its session:

| Turn | Told | Size |
| --- | --- | --- |
| Starts a workflow (`/workflow start`, `/workflow script`) | How to call the tools, the operations, and how to write a script: `agent`, `parallel`/`pipeline`, work queues, swarms, the board, the goal | about 8700 characters, once per workflow |
| Woken by the workflow's events | How to call the tools, the operations, and how to run what exists: what each event asks for, to-dos and how to defer or pass one, taking the result, `staff_swarm`, `tell_worker`, the board, adding work, the goal. No script API; `run_script`, `staff_swarm` and `configure_landing` are listed by name, the first because a wake cannot call it, the others because a line of the text or the guide explains them | about 4700 characters, at every wake |
| An ordinary user message in a topic that has a workflow | How to call the tools, the operations and how to steer | about 2900 characters |

How to speak on the board and what the fields of a work item do are each one text (`BOARD_POSTING`, `WORK_ITEM_FIELDS` in `tools/script-guide.ts`) that the script guide and the wake both carry, so the script's `post`/`enqueueWork` and the operations `ask`/`answer`/`note`/`enqueue_work` are not described twice in different words.

What the engine tells a worker is in English: its system prompt, the frame around each turn's task, the rules of a swarm, the system's posts, a message put into its turn and the errors of the operations. What it tells the main agent and the user is in Chinese. The request, the task and the goal are the user's and the main agent's own words, so the worker's system prompt gives the Chinese terms it will meet (目标 for the goal, 现状 for a status note, 留言板 for the board, 工作项 for a work item, 待办 for a to-do) and asks for notes, results and answers in the language of the task. A worker that may start child workflows still reads the script guide in Chinese, since it is the text the main agent reads.

A persistent member's system prompt describes the operations it can call, about 15,300 characters. The operations only a member that plans work may call (`staff_swarm`, `swarm_finish`, `set_status`, `tell_worker`, `retry_work`, `settle_work` and the parts of `update_work` beyond rewriting, withdrawing or replacing one's own item) are told to the lead of a swarm and the leads of its queues alone, about 5,400 characters more. The work queue is told in the order a member meets it: taking an item, doing it, landing it, what each way a landing is turned back asks for, then adding, finding and withdrawing items.

A long-running swarm wakes the main agent dozens of times, so a wake does not repeat the script API; a wake that has to change the script reads the current one and prints the guide first. The less common script functions (`discuss`, `reviewedAgent`, mailbox and event waits, task handles, worktrees and landing, nested workflows) are described only in the full guide, which any agent prints with `workflow guide` before using them.

### Asking the main agent about a running workflow

While a topic has a workflow, every ordinary message in it runs with that workflow's credentials. The main agent can answer "how is it going" from `status`, and act on a request to cancel a stuck worker (`cancel_task`) or the whole workflow (`cancel_workflow`; its earlier name `cancel` still works), pause, post to the board, enqueue work or replay an edited script, without a `/workflow` command. Such a turn gets a short description of the operations and a few lines of state; `workflow guide` prints the full script guide when a replay needs it. It cannot start a workflow, and the events that are pending when it starts are still delivered by their own wake.

### Events for the main agent

What a workflow raises with the main agent (a worker's reply, a review that is due, a queue that stays dry, a stopped member, a halted landing, the script's result) wakes it when its conversation is idle. A main agent that is in a turn is not idle, and a turn that waits on background work can last for hours; a wake that waited for the turn to end would leave a reply unread all that time. So while a turn runs, what is raised goes into that turn, the way a user's follow-up does: replies and failures at once, reports of how things stand (a dry queue, a review) gathered for up to two minutes so that several arrive as one message, at most eight to a message. A turn whose agent cannot take input mid-turn keeps them for the wake that follows it.

An event does not always need `ack_events`:

- A `worker_reply` or `review_due` only tells the main agent something. It is settled once a turn has it; the reply can be read again with `worker_messages`, and the next review is raised when it is due whether or not anyone acknowledged the last.
- An event that reports a state is settled when the state has ended, whoever saw to it: a dry queue that stayed fed or that its lead put to rest, a failed member that was revived, replaced or retired, a stall that someone ended, a halted landing branch that was restored or adopted, an [ask](#asks-and-answers) that was answered or resolved.
- The rest (the script's result or failure, a binding or budget warning, an outside commit the landing took in) stay until `ack_events`, and `complete` still requires that nothing is pending.

`status`, the result of every change and the workflow context attached to the main agent's turn are a bounded summary (about 40,000 characters of JSON). Lists that grow with the workflow (`tasks`, `artifacts`, `sessions`, `agents`, `checkpoints`, `waits`, `children`, `events`, `script.calls` and the other script call lists, `mailbox.waits`, `swarms.<key>.members`) keep their latest entries, with tasks in progress kept before queued and finished ones; `taskCounts` counts tasks by status and `omitted` counts what each list left out. `status` with `{list, offset?, limit?}` returns one page of a list (16 entries by default, 64 at most) as `{list, stateVersion, total, offset, nextOffset, items}`. `todos` lists at most 40 to-dos, the ones the main agent holds first, and `moreTodos` counts the rest.

### Giving a workflow more time

`extend_deadline(minutes)` moves the deadline of a running or paused workflow later, by up to seven days per call and never to more than fourteen days from now. The time limit chosen at the start is an estimate, and a workflow that is making progress should not be lost to it. Extend before the deadline: once it has passed, the workflow has failed. Worker turns that were already running keep the deadline they started with; turns started afterwards get the new one.

### Changing direction: the goal, and how the work stands

A workflow's request and a swarm's task are fixed when they start. Two texts change afterwards, and they are kept apart because they change at different rates and belong to different people.

The **goal** says what is wanted and how to tell that it is met, with the standing rules (exclusions, how results are measured). It is the user's, so only the main agent changes it: `set_goal(text)` replaces it whole (at most 6000 characters) and needs no state version; a member that calls it is refused. Users read it with `/workflow goal` and replace it with `/workflow goal <text>`. Each lead that can still take a turn is told by a message, which wakes it to re-plan.

A **status** is a lead's account of its part: how far off the goal is now by that test, what is being tried, what was ruled out and where the evidence is, what is not known yet that would change the plan, the priorities, and what each part with a lead of its own must deliver. A lead replaces its own with `set_status({operationId, text})` (at most 3000 characters); the lead of a swarm and the lead of a queue each keep one, and other members are refused. Writing a status wakes nobody.

Every worker turn is given the goal in force when the turn starts, after the request and before its task, with a note when it changed since the member's previous turn, then the status of each lead above the member, the swarm lead's first, and the member's own when it leads. `read_context` returns them as `goal` (`{version, text, at, changed?}`) and `statuses`, and the main agent's `status` shows both. Where the goal differs from the request, the task or earlier notes, the goal wins. A member added after a change of direction therefore starts from the current goal and from how things stand, not from the original task and a pile of announcements.

The two were once one text, the charter, which a lead rewrote whole to record progress. The goal was reworded along with the rest at every revision, and what every member was given as the goal moved away from what was asked for. Use announcements for rulings on single questions, the goal for what is wanted, and a status for what a member must still know about the state of the work a day later.

### Coming back without being called

Members of a swarm run only when something waits on them or their queue has work, and the main agent only when something ends, goes wrong or waits on it. `wake_me` adds a clock to both.

- A swarm member calls `wake_me({operationId, afterMinutes, note?})` (1–1440 minutes) and ends its turn; the kernel wakes it when the time comes, with the note in the prompt. It is how a member waits for a long build, test or queue without holding its turn open, and how a lead comes back to check results while everyone is busy. Each member has one wake-up: calling again replaces it, `afterMinutes: 0` cancels it, and being woken earlier by a to-do, a message or work leaves it in place. It counts toward `maxTurns` like any other wake-up. A swarm without a lead does not go quiet, and one with a lead is not said to be idle, while a member that does the work has a wake-up pending; the lead's own wake-up does not hold a swarm open.
- The main agent calls `wake_me(afterMinutes?, everyMinutes?, note?)`: `everyMinutes` (10–1440) repeats, `afterMinutes` alone fires once, and `0` cancels. When it is due and the script is running, the main agent receives a `review_due` event that tells it to start from the user's request: whether the goal and its test are still what the user wants (and to write them down with `set_goal` where there are none), how far off that is by what was actually produced and how much closer than at the last review, whether anyone is working on the largest part that is left, and what members noted in topic `noticed`; then to cancel or amend work that does not serve the goal, ask the lead for another approach where the one in use does not fit, and change the staff where that does not fit. Two reviews that find the goal no closer call for another approach, not for more of the same items. Only one review waits to be delivered at a time; a recurring wake-up is rearmed either way.

### Changing the staff of a running swarm

`staff_swarm(swarm?, add?, like?, workspace?, harness?, model?, reasoningEffort?, queue?, leads?, role?, brief?, move?, revive?, replace?, retire?, cleanup?, maxTurns?, maxConcurrent?)` lets the main agent adjust a running swarm without replaying the script; a swarm's lead has the same operation for its own swarm. `move` (member names, with `queue`) makes members that consume one queue consume `queue` instead, for when one queue has more work than members and another has members without work: a member finishes the item it holds and takes its next from the new queue, is woken when that queue has work to claim, and is told of the move in its next turn; `role`, when given, replaces the role of the members moved, and `unconsumed` in the answer names a queue that lost its last member while it still holds unfinished items. `retire` names members that finish their current turn and are not woken again. `cleanup` (`"retired"` or member names) releases the managed worktrees of retired members, which otherwise stay against the workflow's workspace budget for as long as it runs; like the script's `cleanupWorkspace`, it removes an idle worktree together with any uncommitted or unintegrated work in it, and a failed member can be cleaned directly when its work is not worth reviving. `add` names new members, bound like an existing one (`like`, by default the first member that is not the lead) and taking its role and queue unless given. `workspace` (`true` or `{base?,repo?,isolation?}`) gives each added member its own managed worktree, bound in the same change. It is made like the worktree of the member `like` names, from the same repository and with the same isolation, at the commit `base` names (default: that repository's current HEAD); only when that member has no worktree is the workflow's own directory the repository, and `repo` names another either way; without it the member runs in the workflow's own checkout, where it cannot `submit_work` and code written in parallel races everyone else. The main agent may bind them differently with `harness`, `model` and `reasoningEffort`, for example to add one member on a stronger model to a swarm of cheap ones: what it leaves out comes from `like`, except that another harness does not inherit the model, and the host checks and resolves the choice as it does for a script's members. The result then carries `execution`, and `workspaces` (`[{name, workspace}]`) for the worktrees it made, and `status` shows `model` (and `harness`) on the members bound unlike the first member that is not the lead. A lead cannot name a harness or model, so members never reach beyond the ones the script and the main agent chose. `revive` (`"failed"` or member names) puts failed members back to work by running their last turn again in the same native session. `replace` (member names) is for when that session is what is wrong, because it fails on every request or is full: the member goes on under its name in a new native session. Its name, role, queue, worktree, scratch directory and checkpoint stay, and so does everything addressed to the name: unread messages, the asks made of it, its to-dos and the items kept for it. A turn the old session left unfinished is given up, and the messages it had been handed go to the new session. The first turn of the new session is told what a member's first turn is told, the note the old session ended its last finished turn with, that its worktree may hold uncommitted changes, and `brief` when one is given. It starts when a member's first turn would, or when something waits on the name, and counts as a wake-up. A member in a turn is not replaced until the turn has ended, a member with no wake-ups left needs `maxTurns` raised in the same call, and `replace` changes neither harness nor model (`add` does). A retired member can be replaced, which brings it back. A member that has had more than one session shows `sessions` in the swarm's member summaries. `maxTurns` raises the number of wake-ups per member. `maxConcurrent` (main agent only, 1–512) changes how many workers of the workflow run at once, which until now only a replay could: members added beyond the number the script was started with would otherwise wait for a slot with work in hand. Use it when members have failed and queued work has nobody left to take it, or when the work has shifted from one queue to another.

`status` lists, for each running swarm, `queues`: per consumed queue the items that are `claimable` now, the `blocked` ones, the `claimed` ones, and its `members` split into `running` and `idle`. A pending count alone does not tell whether idle members have anything to take. What waits on someone because of how a queue stands (it has run dry, its member failed, nobody is left to work it) is under `todos`, with who holds it.

Counts say how a queue stands; two more figures say how it has moved. `flow` gives, for each of the last six hours, oldest first, the items that were `enqueued`, `completed` and `failed` for good; the last figure of each list is the hour that ends now. `dry` adds up the dry spells that someone was told of, once each is over: how many (`spells`), their total `minutes` and the `longestMinutes`. A spell that went on after the queue was fed for a moment is one spell. Completions that fall hour after hour while the members stay are usually a lead that does not plan fast enough, which `dry` and `enqueued` confirm; items that enter faster than they leave point at failing members or at `blocked` items. Each member of the swarm carries `itemsDone` and `itemsFailed`, the items it completed and the ones that failed for good under its claim. `work_status` reports the same `flow` for one queue, or for all of them. The engine keeps these as counts per ten-minute slot, so they cost the same however long the workflow runs.

Agents call the workflow CLI for every claim, post and checkpoint. The bridge ships it as `dist/workflow-cli.js`, the engine's own CLI without the bridge's program: a call starts in about a tenth of a second instead of the one to two seconds the full CLI takes to load. A swarm that has already ended cannot be staffed: that still takes a replay.

Claims no longer depend on members renewing a lease in time. While the turn that holds a claim is running, the engine extends the lease; the claim returns to the queue when the turn ends, is cancelled, or is stopped by the stall watchdog.

### Talking to a running worker

`tell_worker(target, text)` puts a message from the main agent into a worker's session while its turn runs, the way a user's follow-up reaches the main agent mid-turn. `target` is a task ID, a member name or the script key of a one-off worker. The worker may answer each message once with `reply_main({text})`, which raises a `worker_reply` event and wakes the main agent; `worker_messages(target?)` lists the exchange. Use it to correct a worker that is going the wrong way or to ask what it is doing, instead of cancelling it.

The sender does not have to know whether the worker is in a turn. The result is one of:

| `status` | Meaning |
| --- | --- |
| `accepted` | The transport took the message; the model reads it at its next step |
| `unknown` | The transport did not confirm it; the message is recorded as sent |
| `posted` | The message could not enter a turn (the member is between turns, or its harness takes no input mid-turn), so it became a board post that names the member, with its `seq`. The member reads it at its next turn, and a swarm member is woken for it. An `@name` in the text names nobody else |
| `inactive` | No turn is running and none will come to read a post: a one-off worker that has ended, or a member that has stopped |
| `unsupported` | A one-off worker whose harness takes no input mid-turn |

A swarm's lead and the leads of its queues have the same operation as a worker tool, `tell_worker({operationId, target, text})`, so that a lead that sees a member heading the wrong way does not have to wait for that member's turn to end. The swarm's lead may speak to any member of its swarm, the lead of a queue to the members that consume its queues; other members are refused and use the board. The member sees the message as coming from that lead and answers on the board, not with `reply_main`. What leads say this way is in `worker_messages` with `from: "lead"` and the lead's name in `by`. Repeating a call with the same `operationId` and input returns the first result without speaking twice.

## Harness and model selection

| Selection | Configuration | Scope |
| --- | --- | --- |
| Main agent | `/config run` for bot defaults; `/model`, `/effort` for local overrides | Resolved defaults plus current chat/topic overrides, captured at workflow creation |
| Worker defaults | `run_script.execution: {agentKind, model?, reasoningEffort?}` | Calls without an explicit override |
| Individual worker | `agent(..., {harness, model, reasoningEffort, key})` | This call only; each call can select another model |

Worker defaults do not change the main agent. With no override, workers inherit settings for the selected harness. Switching harness does not carry a different harness's model name. Explicit model selection is recommended for reproducible runs; an omitted native default is not a frozen model version. The model is part of the cache fingerprint, so changing one worker's model reruns that task and any downstream calls whose inputs change.

Only the original authorized profile, workspace and effective permissions are used. Arbitrary profile names, environment variables or credentials cannot be supplied by a script. The target must provide authoritative `final_text` and support the requested model/access mode. Native IDs are recorded from backend system events and stay outside the root session catalog. Progress, partial output and non-normal completion cannot become worker results.

## Script API

A script is a JavaScript **function body** with top-level `await` and `return`. Control flow is ordinary JavaScript: a worker's result can select a branch, create more calls, or feed subsequent stages. No static graph needs to be declared. See [scheduling controls and design references](workflow-scheduling.md), and [the cross-harness review example](../workflow-definitions/scripted/examples/review.js).

```js
const [proposal, constraints] = await parallel([
  () => agent(args.subject, { key: 'proposal', harness: 'pi', model: args.proposalModel }),
  () => agent('List constraints: ' + args.subject, { key: 'constraints', harness: 'claude', model: args.constraintsModel }),
]);
return await agent(JSON.stringify({ proposal, constraints }), {
  key: 'decision', harness: 'codex', model: args.decisionModel,
});
```

Submit a JSON envelope using the existing scope-bound CLI:

```sh
node "$AGENT_WORKFLOW_CLI" workflow run_script --input-file workflow.json --json
```

The envelope has `operationId`, `goal` (the full authorized task), `script` (the function body as a string) and `plan` (a human-readable execution plan, up to 12,000 characters). The plan must describe phases, each worker's harness/model/task, dependencies and conditional branches. Lark publishes it before any worker starts; delivery failure stops execution. This is visibility, not a new approval gate. The plan is stored as a versioned `workflow-plan` artifact (`planRef`); the exact script remains available through `sourceRef` and `read_artifact`. A plan describes intended behavior; `/workflow status` shows the actual branches and tasks reached. Optional fields:

| Field | Meaning |
| --- | --- |
| `name` | Display name, up to 100 characters |
| `args` | JSON data exposed as `args` in the interpreter |
| `execution` | Default `{agentKind, model?, reasoningEffort?}`; otherwise root harness/settings |
| `maxAgents` | Calls per script run, default 32; cache hits count. There is no fixed maximum: ask for what the run needs |
| `maxConcurrent` | Concurrent workers per workflow tree, default 4, maximum 512. Workers take slots from the profile's process pool, so `max_concurrent_runs` (at most 512) must be larger than this for the workflow to reach it |
| `timeoutMs` | Total workflow deadline, defaulting to the configured `workflow_timeout_minutes` (480 minutes); range 1 second to that configured limit. Replay does not extend it |

Set the budget in `config.toml`, globally or under `agents.<kind>.run` / `profiles.<name>.run`:

```toml
[defaults.run]
workflow_timeout_minutes = 480
```

The range is 1–10080 minutes. After changing it, use `/config reload` in each affected bot. New workflows capture the configured budget; existing workflows, replay and child calls keep the saved limits and cannot extend the original deadline.

Workers use the shared executor's automatic retries for HTTP 429 and recognized
transient connection/server failures, including a stream closing before
`response.completed`. Backoff is 30 seconds, then 60 seconds, then 120 seconds,
with at most 100 consecutive retries; substantive progress resets the budget.
The task stays running and keeps its run/session identity during backoff. After
partial progress, retries resume the native session with a continuation prompt.
If that session identity is unavailable, partial work is not replayed automatically.
Cancellation and the total workflow deadline also stop retries; backoff counts
toward `timeoutMs`. Policy refusals, authentication/quota errors and invalid
requests are not retried. A failed worker rejects `agent()` after recovery is
exhausted or unavailable.

A worker that goes silent is stopped and its attempt retried, up to three times.
Silent means no output for the profile's idle timeout (15 minutes by default)
while no tool call is out. A call that is out explains the silence only for as
long as the agent lets the call run: where Bridge knows that limit (Pi's shell
and file tools, see [configuration](configuration.md)), the worker is stopped
two minutes after the limit has passed without a result; otherwise after seven
hours of silence. Long commands are therefore safe as long as the worker names
a timeout that covers them, and a call that never returns no longer holds its
slot until the workflow ends.

Guest functions:

| API | Behavior |
| --- | --- |
| `agent(prompt, {key, member?, harness?, model?, reasoningEffort?, output?, schema?, onError?, workflowTool?, workspace?, inputs?})` | Promise of final text, a parsed JSON value with `output: "json"` or `schema`, or `null` when the worker fails (see [Failure handling](#failure-handling)). `inputs` lists 1–16 keys of earlier, awaited agent calls in this run; their results reach the worker by reference (ref plus a 2000-character preview) and it reads the full text with `read_artifact` |
| `createWorkspace` / `freezeWorkspace` / `approveChange` / `integrateChanges` / `checkWorkspace` / `acceptIntegration` / `cleanupWorkspace` / `configureLanding` | Opt-in isolated coding, snapshot review and checked private integration; see [worktrees](workflow-worktrees.md) |
| `reviewedAgent(prompt, {key, criteria, worker?, reviewer?, maxRounds?, onError?})` | Independent verification and bounded rework; returns only an accepted result, otherwise `null`; see [collaboration controls](workflow-collaboration.md) |
| `discuss(topic, {key, members, maxTurns?, summary?, onError?})` | Multi-agent discussion through the mailbox; members choose recipients each turn; see [multi-agent discussion](#multi-agent-discussion) |
| `swarm(task, {key, lead?, members, maxTurns?, onError?})` | A group of members scheduled by the bridge: woken by board posts that name them and, with `queue`, by claimable work; an optional lead adds and retires members and decides when to finish; see [message board](#message-board-and-swarms) and [queue consumers](#queue-driven-consumers) |
| `post(text, {key, to?})` / `readBoard({key, after?, limit?, member?})` | Post to the workflow's message board as the script, or read the feed; see [message board](#message-board-and-swarms) |
| `send(member, text, {key, topic?, correlationId?})` / `receive(member, {key, topic?, correlationId?, timeoutMs?})` | Send a durable message or await a stable inbox batch |
| `enqueueWork({key, title, input, queue?, priority?, dependsOn?, resources?, writes?, maxAttempts?})` | Persist an immutable work item; returns `{itemId, key}` and reuses it on replay |
| `workStatus({itemId?, queue?, offset?, limit?})` | Read one item with its payload, or bounded queue counts and summaries |
| `closeWorkQueue({key, queue?})` | Persist queue closure; existing items continue, new items are rejected |
| `parallel([() => ..., () => ...])` | Starts functions and returns results in input order; a function that throws yields `null` |
| `pipeline(items, ...stages)` | Processes items concurrently; each item passes through its stages sequentially as `stage(value, index)`; a throwing stage yields `null` for that item and skips its remaining stages |
| `startAgent(prompt, options)` / `joinTask(handle)` | Start an independent managed task and await its result |
| `cancelTask(handle, {key})` / `raceTasks(handles, {key})` | Cancel and await task-tree cleanup, or select the first terminal task and cancel the rest |
| `waitFor({key, any})` | Durably select a message, work completion, task completion or timer |
| `waitWork(itemId, {key})` / `sleep(ms, {key})` | Wait for a work item or a durable timer without a worker process |
| `phase(text)` / `log(text)` | Bounded progress recorded in status; does not wake main |

With `output: "json"` (or `schema`), the final answer is parsed strictly first, then from its last fenced code block (a summary before the fence is common), then through the host's syntax repair (the bridge uses `jsonrepair` for complete objects only). The script receives canonical JSON. If none of these succeed, or the value does not match `schema`, and the worker reported a native session, the same attempt resumes that session up to twice with the parse or validation errors and asks it to restate the previous answer as JSON only, without repeating work. Only if that also fails is the task failed with `Agent output is not valid JSON` or `Agent output does not match schema: …`. The follow-up turns wait for a process-pool slot like any other turn.

`schema` is a JSON Schema whose root is `{type: "object", properties: {...}}`; `required` must name declared properties. The supported keywords are `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `anyOf`, `minItems`/`maxItems`, `minLength`/`maxLength` and `minimum`/`maximum`, plus annotations such as `title` and `description`. Any other keyword (for example `pattern` or `$ref`) is rejected when the call is made rather than silently ignored. The schema is appended to the worker prompt and is part of the cache fingerprint. Validation happens in the bridge after the native answer; it is not a native structured-output tool, so a worker can still produce a mismatching answer that exhausts the retries.

### Failure handling

A worker's own failure does not fail the script by default. `agent()` resolves to `null` when the task fails after the executor's retries: execution or policy errors, a native question, invalid JSON, a schema mismatch or a missing final answer. The task remains `failed` in `/workflow status` with its error, and a script log line records which key returned `null`. A task that ended with a native question stays `waiting_input`, raises a notice with the question that wakes the main agent, and is cancelled when the workflow is paused, invalidated or restarted instead of holding its session forever. Pass `onError: "throw"` to reject instead; the error has `name: "WorkflowAgentFailure"`. Invalid calls still reject regardless of `onError`: unknown options, duplicate keys, a member with an unfinished turn, and call, task or deadline budgets.

`parallel` and `pipeline` never reject: a function or stage that throws, including one using `onError: "throw"`, yields `null` in its position and records a log line. Filter results with `.filter(Boolean)` or check for `null` before using them. `reviewedAgent` and `discuss` also resolve to `null` on failure (including review rejection after `maxRounds`) unless given `onError: "throw"`; option validation errors always throw. `joinTask` and `raceTasks` keep rejecting on a failed task. Failed ordinary calls are not cached, so replay retries them; a failed member turn must still be replayed before that member can take another turn.

`key` is required, stable across replay, and unique within one run. A selected harness uses its configured defaults unless model/effort overrides are supplied. Switching harness does not inherit a different harness's model. All calls must be awaited; the interpreter rejects a result while agent calls are still pending. Worker failures resolve to `null` unless `onError: "throw"` is set; see [Failure handling](#failure-handling). Without `schema`, JSON parsing does not validate structure: check required fields in the script.

Only script completion/failure creates a main-agent event, rather than an event for every worker. Final return values are serialized into a `workflow-result` artifact; no return means JSON `null`. The main agent reads the artifact, acknowledges events, and calls `complete` with that artifact reference, `openIssues` and `verificationLimits`. Persistent members can checkpoint their own work and send internal mailbox messages. Workers cannot send parent answers, manage other members, or recursively delegate through the workflow API. Worker scheduling belongs to the script; explicitly enabled `workflowTool` callers may create child workflows as described below. Named members continue their native sessions; ordinary agent calls remain independent. A main-authored `report` artifact can also be used for completion.

### Choosing the shape of a workflow

The main agent decides how the task should be organized and states the reason in the plan:

- **Segmented work** fits tasks that split into parts with independent evidence, such as scanning modules or checking separate hypotheses. Use `parallel`/`pipeline`, then verify the important conclusions independently.
- **Discussion** fits questions that converge through argument: choosing between designs, challenging a proposal, or reconciling conflicting findings. Use `discuss`.
- The two combine. For example, gather evidence in parallel, then have members debate what it shows.

### Multi-agent discussion

`discuss` runs a discussion among 2–6 persistent members. Members address each other; the script does not fix the speaking order.

```js
const result = await discuss(args.question, {
  key: 'design',
  members: [
    { name: 'proposer', role: 'Defend the simplest viable design', harness: 'codex', model: args.proposerModel },
    { name: 'critic', role: 'Find failure modes and missing evidence', harness: 'claude' },
    { name: 'operator', role: 'Judge rollout and operational cost', harness: 'codex', model: args.operatorModel },
  ],
  maxTurns: 12,
});
return result.summary;
```

1. **Opening.** Every member first gives an independent opening position in parallel, so nobody anchors on whoever speaks first.
2. **Replies.** Each reply is JSON `{message, to?, agree}`:
   - `to` lists the recipients; omitting it addresses everyone and `[]` stays silent;
   - unknown names and the speaker itself are dropped;
   - messages over 3,900 characters are truncated.
3. **Delivery.** The helper relays each message through the mailbox under the speaking member's name, so the recipient's next turn sees the correct `from`. The kernel accepts a relay only when its text repeats that member's latest reply; public `send()` cannot choose a sender.
4. **Rounds.** In each round, every member with unread messages receives them and replies in parallel. Each member continues its original native session.

The discussion stops on the first of these conditions:

| `stop` | Condition |
| --- | --- |
| `consensus` | Every member's latest reply has `agree: true` |
| `quiet` | No member has unread messages |
| `max_turns` | `maxTurns` turns after the opening are used (default 12, maximum 32) |

The last round's messages are sent only when another round can read them.

**Return value.** `discuss` returns `{stop, turns, rounds, transcript, summary}`:

- `transcript` lists `{turn, from, to, agree, text}`; openings have turn 0.
- `summary` comes from an independent agent and is validated as `{conclusion: string, agreements: string[], disagreements: string[], openQuestions: string[]}`, or is `null` when disabled. Converting it to a string (template literal, `String()`) yields readable text with all four parts; `JSON.stringify` keeps the structured fields. Pass `summary: {harness, model, reasoningEffort}` to choose that agent, or `false` to skip it.

**Keys and replay.** Member turns use the keys `<key>/open/<name>` and `<key>/r<round>/<name>`. Replay reuses completed turns and deduplicated messages.

**Constraints.**

- Member names are 1–40 letters, digits, `_`, `.` or `-`. They are dedicated to the discussion: do not also drive them with `agent()` or `receive()`.
- Every turn counts toward `maxAgents`.
- members × (members − 1) + `maxTurns` × members must not exceed 120, which keeps one discussion within the per-run mailbox budget.
- Members address each other through their reply; they have no tool for sending messages on their own.

See [the debate example](../workflow-definitions/scripted/examples/debate.js).

### Message board and swarms

Every workflow has one message board: an ordered, append-only feed that all of its agents can read. What is written on it is one of three things. A **note** tells: it names nobody, wakes nobody and is read when someone looks. An **ask** wants an answer or an action from one member, or from the main agent: it is delivered to that one, wakes it, and stays its [to-do](#to-dos) until it is answered. An **answer** closes an ask and is delivered to whoever asked. A script's `post` may still name members, which delivers the post to their inboxes. Posts are never edited or removed; a post that needs nobody any more is [marked resolved](#resolved-posts), which takes it out of the default reads.

| Caller | Write | Read | Resolve |
| --- | --- | --- | --- |
| Persistent member | `ask` with `{operationId, to, text, withinMinutes?, topic?}`, `answer` with `{operationId, ask, text}`, `note` with `{operationId, text, topic?}` | `read_board` with `{after?, limit?, member?, topic?, resolved?}` | `resolve_post` with `{operationId, seq, note?, see?, reopen?}` |
| One-off worker | not allowed | `read_board` | not allowed |
| Main agent | `ask(to, text, withinMinutes?, topic?)`, `answer(ask, text)`, `note(text, topic?)` | `read_board(after?, limit?, member?, topic?, resolved?)` | `resolve_post(seq, note?, see?, reopen?)` |
| Script | `post(text, {key, to?, topic?})`, as `script` | `readBoard({key, after?, limit?, member?, topic?})` | none |
| User | `/workflow post <text>` (a note) and `/workflow post @member <text>` (a message to that member), as the main conversation | `/workflow board [count\|member\|#topic]` | through the main agent |

A long-running workflow collects hundreds of posts. `search_board` with `{query, member?, topic?, limit?}` finds posts by words instead of paging through the feed, for members, one-off workers and the main agent alike: `query` is up to 8 space-separated words, each matched as a case-insensitive substring, and all of them must occur in the post. The result lists the newest matches (10 by default, at most 30) with their `seq` and the text around the match; `read_board({after: seq - 1, limit: 1, resolved: true})` returns a whole post. Posts that have been archived out of the state are searched too.

- `text` is at most 4000 characters. A note names nobody: an `@name` in it is ordinary text, and a `to` is refused with a pointer to `ask` and `tell_worker`. An ask names exactly one reader in `to`. In a script's `post`, `to` is an array of member names or `"all"`, and `@name` and `@all` in the text count as well; unknown names in `to` are rejected, an `@word` that matches no member is ordinary text, the sender is never its own recipient, and `all` means the members that exist when the post is made.
- A read returns `{posts: [{seq, from, to, all?, topic?, text, at, resolved?}], lastSeq, hasMore, resolvedSkipped?, topics?}`. Without `after` it returns the latest `limit` posts (default 20, at most 50); with `after` it returns the posts following that `seq`. `member` keeps the posts that member wrote or received. `from` is a member name, `main`, `script` or `system`.
- Deliveries are ordinary inbox messages with topic `board` and the fields `post`, `to` and `all?` added, so everything that waits for messages works unchanged: `receive` and the `message` arm of `waitFor`. Swarm members are woken by them directly. As with direct messages, a member sees them in its next turn's member context and they are acknowledged when that turn succeeds.
- The number of posts is not limited. The state keeps the latest 256; older ones move to the workflow's archive, where reads and searches find them as before, and are deleted with the workflow once its retention has passed. At most 32768 deliveries are held at once. Deliveries reference the post instead of copying its text and do not count toward the 4096 direct messages.
- A script read records how far the feed reached under its `key`; replay reads the same range again. It returns every post of that range as posted: resolutions are made later and would change what a replay reads, so a script read neither skips resolved posts nor reports them.

#### Topics and announcements

A board that hundreds of members write to mixes rulings everyone must know, coordination inside one workstream and requests for help. A post may carry a `topic` so that readers take one of these at a time:

- `topic` is 1–40 lowercase letters, digits, `_`, `.` or `-` (upper case is folded). A post without one belongs to `general`; its view carries `topic` only when it is another one. A board holds at most 64 topics besides `general`: a topic is a workstream, not a tag for one post.
- `read_board` and `search_board` take `topic` to keep the posts of one topic. Once the board has more than one topic, a read by a member or the main agent also returns `topics: [{topic, posts, lastSeq, resolved?}]`, the busiest first; a script read does not, because the list would differ on replay.
- Topic `announce` is for rules and rulings. Only the main agent, the script and the lead of a swarm may write in it. An announcement is a note: every member is given the ones made since its previous turn at the start of its next one, so a rule change reaches a large swarm without waking it. What a member must act on now is an ask, or `tell_worker`.
- A member's `read_context` carries `board: {lastSeq, since, older?, topics: [{topic, posts, lastSeq, resolved?, new}], announcements, moreAnnouncements?}`. `since` is the board's `lastSeq` when the member's previous turn was scheduled, so a post made during that turn may be reported twice but none is missed. `announcements` holds up to five new ones in full; `moreAnnouncements` counts the rest. `new` counts the new posts of a topic among those still in the state (the latest 256 of the board); `older` is how many new posts have left it.
- Members are told not to post a report when they complete a work item: the result given to `complete_work` is the report, and `search_work` finds it.
- `/workflow board #topic` shows one topic in chat.

#### Resolved posts

The board is append-only, so without anything else every question that was answered and every conclusion that was later overturned stays in front of the readers for as long as the workflow runs. Deleting such posts would lose what they are good for: a later member who is about to ask the same question, or to try what already failed, finds out by searching. A post is therefore marked instead:

- `resolve_post` with `{seq, note?, see?}` marks a post that needs nobody any more: its question was answered, its request done, its conclusion replaced. `seq` is one post or an array of up to 32. `note` (at most 500 characters) says in a sentence how it was settled, `see` is the `seq` of the post that answers or replaces it; at least one of them is required, so that a reader who finds the post learns how it ended.
- The author of a post, a member the post is addressed to by name (not through `all`), a lead of a swarm or of a queue, and the main agent may resolve it. An announcement is resolved by those who may announce: the main agent and the lead of a swarm. One-off workers and scripts cannot resolve.
- `resolve_post` with `{seq, reopen: true}` removes the mark, under the same rule. Resolving a post that is resolved, or reopening one that is not, changes nothing and lists it under `unchanged`; the first resolution stays. The result is `{resolved?: [seq], reopened?: [seq], unchanged?: [seq]}`.
- `read_board` skips resolved posts and reports how many it passed over as `resolvedSkipped`; `resolved: true` returns them as well, each with `resolved: {by, at, note?, see?}`. A member's `board` digest counts only unresolved posts as `new` and does not hand over an announcement that was resolved in the meantime. A topic's `resolved` is how many of its `posts` are resolved.
- `search_board` finds resolved posts too, after the unresolved ones and with their `resolved` field; the note is searched like the text.
- A delivery of a post that has been resolved by the time its recipient reads it carries `resolved` as well: somebody already dealt with it.
- The mark is part of the post wherever the post is kept: resolving one that has left the state changes its archived entry, the only kind of archived entry that is ever rewritten.
- `/workflow board` lists resolved posts with their resolution and a shortened text, and gives the number of resolved posts beside each total.

#### Asks and answers

A note tells. Nothing about it says that its author is waiting, so a question written as one depends on its reader's attention at the moment it happens to be read. An ask is for what its author waits for, an answer or an action, from one reader:

- `ask` with `{to, text, withinMinutes?, topic?}` asks one member. `to` names the one that owes the answer; a name in the text of a question is as often its subject as its addressee. `withinMinutes` (1–1440, 15 by default) is how long the author can wait before those above the member asked hear of it. The main agent and persistent members ask; scripts do not. A member with no lead above it (the lead of a swarm, a member of a swarm without one, a member of no swarm) may ask the main agent with `to: "main"`; any other member asks the lead above it.
- The ask is delivered once and wakes the member asked, or enters the turn it is in (below). From then on it is a [to-do](#to-dos) of that member: in the first lines of the brief of every turn and in `read_context` under `todos`, until it is answered. The asker's own open asks are in its brief and in `read_context` under `asked`.
- `answer` with `{ask: seq, text}` answers it. The answer is delivered to whoever asked, in the topic of the ask, and closes the ask in the same step. The member asked, a lead and the main agent may answer; the author's own `answer` withdraws the ask. When the main agent asked, the answer reaches it as a `worker_reply` event. A member that cannot answer yet answers with what it waits on.
- `resolve_post` closes an ask without an answer: by its author, when it no longer waits, or by one of those who may answer, with a `note`. The author is told how it ended unless it closed the ask itself. `resolve_post` with `reopen` makes the ask owed again.
- An ask made of a swarm member that is in a turn, and the answer to an ask of such a member, enter that turn as a user message instead of waiting for its next one, where the member's harness takes input while a turn runs (the condition `tell_worker` has): whoever asked is usually waiting. At most 4 enter at once, no sooner than 5 seconds after the last, and 16 in one turn; a post over 2000 characters is cut there and names the `read_board` call that has the rest. What entered a turn is input of that turn: `read_context` lists it, a retry of the turn is handed it again, and it wakes the member for no turn of its own. The harness acknowledges that it took the words, not that the model read them, so nothing rests on that alone: an ask stays a to-do until it is answered, and the member's next brief names the answers its last turn was shown. A member between turns, a harness without input mid-turn, a member of no swarm and a receipt that was lost leave the post in the member's messages, as before. Notes and rulings never enter a running turn.
- An ask that stays open goes up like any other to-do: when the time its author gave has run out, to the lead of the queue the member asked consumes, then to each lead above that one, then to the main agent, which is not told sooner than fifteen minutes after the lead below it was. Each of them reads how the member asked stands (in a turn, between turns, stopped) and can answer in its place, reach it in its turn with `tell_worker`, or close what needs no answer. Where the author itself stands above the member asked, the ask goes no further up than the author.
- An ask addressed to the main agent is told to it at once, as an `ask` event, which is settled when the ask is answered or closed.
- At most 128 asks are open on a board and 8 from one author. Topic `announce` takes no asks: an announcement is for everyone, an ask for one reader.

An ask carries no meaning beyond "this needs an answer from you, and I am waiting": what is asked may be a ruling, a review, a fact, or the confirmation of a hand-off. What the answer permits or forbids is for the goal, the items and the landing configuration to say.

#### To-dos

A swarm needs someone to act on things that nobody is working on: a queue with nothing to claim, a member that failed, an ask nobody answered, an item that waits on something that will never happen. Telling someone at the moment such a thing happens does not work well: whoever is told may be in a long turn, the thing may be over before the message is read, and a second message about the same thing is one more to read. So nothing is sent when something happens. On every scheduling pass the engine works out which situations hold now, from the state as it is, and keeps one table of to-dos in step with them:

| Kind | The situation | First answered for by | Told after | Goes up after |
| --- | --- | --- | --- | --- |
| `ask` | An open ask | the member asked | at once | the time the asker gave (15 minutes by default) |
| `dry` | A queue of which a quarter of the members, one at least, are idle while it has nothing they can claim | the lead that plans the queue | 2 minutes | 20 minutes |
| `idle` | Nobody in the swarm has anything to do, and nothing else waits on anyone in it | the lead of the swarm | at once | 10 minutes |
| `member` | A member failed and has stopped, after the one retry the engine gives it | the lead of the swarm | at once | 15 minutes |
| `unstaffed` | A queue has work to claim and no member left that could be woken for it | the lead of the swarm | 2 minutes | 15 minutes |
| `aside` | An item set aside (`hold`) that nothing else keeps from being handed out, once what it waited on is done or an hour has passed | whoever set it aside | at once | 60 minutes |
| `dead` | An item has waited for ten minutes on one that was cancelled or failed for good | the lead that plans the item | at once | 30 minutes |
| `gate` | A gate nobody has declared met keeps work back, for an hour or while nobody in the swarm is at work | the lead that plans the gate | at once | 60 minutes |
| `spin` | An item was taken three times in a row and came back each time with no progress saved and no failure reported | the lead that plans the item | at once | 30 minutes |

- A to-do has a chain: whoever answers for it first, then each lead above that member, then the main agent. In a swarm without a lead, and for an item no lead plans, that is the main agent alone.
- The member that holds a to-do is woken for it and reads it in the first lines of the brief of every turn, with how things stand now and what it can do; the text is worked out when it is shown, not when the to-do was first told. `read_context` lists them as `todos`. One to-do covers every item of its kind that one member answers for, so a plan that left twenty items behind is one line to read.
- A to-do ends when its situation does: the queue is fed, the ask answered, the member revived, replaced or retired. Nobody marks it done. A dry queue must stay fed for three minutes before its to-do ends, since one item that an idle member takes at once has not ended the spell.
- `defer_todo` with `{id, note, minutes?}` says "not now": the to-do stays, is put in front of nobody and does not go up, for `minutes` (1–1440) or, without them, for as long as its situation lasts. The note says why, and what would change that. It is how a lead says that a queue has no work for now, or that a gate is still to come.
- `pass_todo` with `{id, to, note?}` hands it to another member that can still take a turn, or to `main` (a member with a lead above it passes to that lead); the receiver holds it from then on and is woken for it.
- A to-do its holder leaves open goes up one level when the time in the table has passed, and the holder still reads it. It does not go up over a member that has not had a turn since it was told, or is still in that turn: such a member is given twice the time, and nothing waits longer than three times it. Whoever holds a to-do, a lead above that member and the main agent may defer or pass it.
- The main agent is the top of every chain. A to-do that reaches it raises a `todo` event (an `ask` event for an ask addressed to it), which is settled when the to-do ends, is deferred or is passed on; one that stays open is told again every hour. `status` lists every to-do that someone was told of under `todos`, with its holder and who left it open.

Not done: members do not subscribe to topics, and nothing assigns a topic from the queue or work item a member holds; the per-turn summary lists every topic.

`swarm` declares a group of persistent members that work on the board. The bridge schedules their turns; the script only awaits the outcome:

```js
const outcome = await swarm(args.task, {
  key: 'ship',
  lead: { name: 'lead', role: 'Split the work so pieces do not collide, hand it out as work items, judge results. Do no implementation yourself.' },
  members: [
    { name: 'parser', role: 'Own src/parser/**.', harness: 'codex', model: args.workerModel },
    { name: 'docs', role: 'Own docs/**.', harness: 'codex', model: args.workerModel },
    { name: 'qa', role: 'Try what was delivered and run the tests; add what you find as items with origin.', harness: 'claude' },
  ],
  maxTurns: 6,
});
return outcome.result;
```

1. The task becomes the swarm's first post. What each member does then depends on its part, of which there are three:
   - The **lead** (`lead`) plans and judges and does not do the work. It takes an opening turn, in which it writes its status and hands out the first work items.
   - A **member that does the work** consumes a queue: the one it names with `queue`, or `default` when the swarm has a lead and the member names none. It takes no opening turn; it starts with the first item it can claim, with the task, its role, the roster and its rules in that prompt.
   - In a swarm **without a lead**, a member that names no queue works on the task itself, side by side with the others: it takes an opening turn and afterwards answers what it is asked.
2. After a turn a member sleeps without a worker process. It is woken when something waits on it (a [to-do](#to-dos) it was not yet briefed with, a message, an answer to its ask), when its queue has work it can claim, when results it is owed have gathered, or when a wake-up it set with `wake_me` is due. Members never wait for each other, so a long implementation turn does not delay a question between two other members. Every turn after the first starts with a brief: what waits on the member, its open asks, new rulings, the results that came back (for a lead) and what it can claim.
3. With a `lead`, the swarm ends when the lead calls `swarm_finish`; without one, when every member is asleep and nothing waits to be read. Members with a `queue` add a condition, described under [queue consumers](#queue-driven-consumers).

The lead has these operations more than the other members, besides the ones for planning work (`update_work`, `retry_work`, `settle_work`, `tell_worker`) and `set_status`:

| Operation | Effect |
| --- | --- |
| `staff_swarm` with `{operationId, add?, like?, workspace?, queue?, leads?, under?, role?, brief?, move?, revive?, replace?, retire?, cleanup?, maxTurns?}` | Changes the staff of its swarm while it runs: `add` names new members that use the harness, model, role and queue of the existing member `like` (default: the first member other than the lead) and see `brief` in their first turn; `workspace` gives each of them a managed worktree made from the repository of the `like` member's worktree (the workflow checkout when it has none); only the main agent can give them another harness or model; `move` (names, with `queue`) takes members of one queue to the work of another; `revive` puts failed members back to work; `replace` gives members that are not in a turn a new session under their name, with `brief` for its first turn; `retire` lets members finish the turn they are running and never wakes them again; `cleanup` releases the worktrees of retired members; `maxTurns` raises the wake-up limit |
| `swarm_finish` with `{operationId, result}` | Records the final result (at most 16000 characters). Nobody is woken afterwards; the swarm returns once the turns still running have ended |

- A member's failed turn is retried once in its own session, as `revive` would have it. When it fails again the member stops, which is a `member` to-do of the swarm's lead: revive it, replace its session, add another member or retire it. An item it had claimed is back in its queue.
- A queue has run dry when a quarter of its members, one at least, are idle while it has no item they can claim. Items are done faster than a lead that is woken every few minutes hands them out, so after two minutes this is a `dry` to-do of the lead that plans the queue, which is woken for it without waiting for its gathering gap. The to-do gives the figures (idle members, and the pending items that cannot be claimed, with why) and asks for a decision, not for items: a lead that is told to keep every member supplied fills its queues with what can always be made up, which is looking into things and writing about them, and a swarm then completes items by the hundred while its goal stands still. So the lead adds the work the goal needs if there is any, and otherwise says with `defer_todo` that the queue has no work for now, or moves its members with `staff_swarm`. A deferred queue is asked about again when it runs dry anew.
- A dry spell is over when the queue has stayed fed for three minutes. An item that an idle member takes at once feeds the queue only for an instant, and the queue is dry again within the same spell: its to-do stays with whoever holds it and the times are not counted anew. Otherwise a queue that gets an item now and then would never reach the main agent, however long most of its members had nothing to do.
- A queue that is empty while the goal is not met says that the plan does not reach the goal, so the lead is asked first what the goal still lacks that these members could work on: a step it knows, or something that has to be found out. What tells such work from filler is not that its outcome is certain but that something hangs on it. An item says what it is for (the part of the goal it moves), and an item that looks into what is not known names the question, what each answer would decide and how much effort it is worth; one whose result would change nothing whichever way it comes out is not added.
- When a member completes a queue item, or an item fails for good (its member gave it up with no attempts left), the result is owed to the lead that planned it. Without this a lead hears only of what goes wrong and plans the next work without the results of the last. Results are not posted: they are in the brief of the lead's next turn, by queue, failures first, up to 48 to a turn, with what is left over waking the lead for its next one. They share the room of the brief, so a single result is quoted up to 1500 characters and a dozen get a line or two each; `work_status({key})` has an item in full. While other members are working, a lead is woken for results at most once per gap after its last turn (30 seconds for each member that works under it, 10 minutes at most); when nobody else is working it is woken at once. A swarm without a lead hands nothing over, and neither does an item that returns to its queue for another attempt.
- Members are told to keep to the purpose of an item rather than to its wording (take a clearly better way within what the item touches, and say so in the result). What reaches beyond the item is new work, and a swarm finds most of its work this way. A lead and a worker are given one rule for it in the same words: whoever sees something the goal needs and no item covers looks for it with `search_work` and adds it with `enqueue_work` in the turn it is seen, and nobody has to allow it. A member used to mention such things in its result or note them for its lead, which was to turn them into items. But a lead reads a line or two of each result, and in long runs the notes piled up by the hundred with few of them marked as dealt with: what is only mentioned waits on somebody else, and may wait for good. The worker goes on with its own item and whoever is free takes the new one; the result comes back to the lead of that queue as any other does. The item says which part of the goal it moves, like every item: what a member cannot say that for is not work. A lead therefore steers what is in its queues rather than handing out every item (it orders, amends and cancels, and says in its status what is wanted more of and what is not), and it does not ask whoever stands above it what to do next or for leave to add work: the main agent is asked only for what the swarm cannot settle itself, the goal and its test and what only someone outside can give. Topic `noticed` is left for what changes the plan without being work for anyone (a way that cannot work, something the plan takes for granted that is not so). Such a note wakes nobody: a lead is told in its brief how many are new and reads the topic at its review; when items in a queue rest on it, the member asks the lead as well, which alone can amend or cancel them.
- A lead is woken by what came back, and a turn that starts from what came back plans the next step of what is already being done; over a long run nearly all items are added inside the swarm, most of them after a result, and the plan walks away from the goal by steps that each look reasonable. So the wake-up a lead sets for itself with `wake_me`, and every eighth of its turns, is a review that starts from the goal: how far off it is now by its test and what moved it, which part of that distance each queue's work closes (what closes none is cancelled or amended), what the largest remaining part is and whether anyone is working on it, what members noted in `noticed`, and then its status, rewritten. Two reviews in a row that find the goal no closer mean that the plan is wrong, not that it needs more of the same items.
- A member's rules are part of its first turn only, and a long run compacts them away. So the brief of every later turn says who the member is and who stands above it, and a lead's ends with what it is there for (judge what came back by how far the goal has moved, leave each queue with the work the goal still needs, idle members are not a reason to add items) and the figures it acts on: for each of its queues, the claimable items against the idle members.
- Idle members are not a verdict. When nobody in the swarm has anything to do, nothing can be claimed and nothing else waits on anyone in it, that is an `idle` to-do of the lead: check the goal against evidence, and either finish or find what is missing and hand it out. Left open, it goes to the main agent after ten minutes. The swarm keeps running: an ask or a message to a member, new work in a consumed queue, or `staff_swarm` (more members, a higher `maxTurns`) sets it going again. Only `swarm_finish` ends it, so state a checkable goal and have the lead finish on evidence.

#### Leads of queues

One lead that splits the work, hands it out and judges every result is the limit of a large swarm: its queues run dry faster than it refills them. A member declared with `leads: "queue"` (or a list of queues) plans that part of the work under the swarm's lead:

- It does not consume a queue. It splits its part into items with `enqueue_work`, judges what comes back and keeps a status of its own, which the members of its queues are given at every turn. Like the swarm's lead it is told to plan and judge and not to do the work itself, and it is not bound by `maxTurns`.
- The result of an item goes to the lead that added it; when its author is not a lead, to the lead of the item's queue; and to the swarm's lead when the queue has none. So an item the swarm's lead puts into a led queue comes back to the swarm's lead.
- What waits in its queues waits on it first: a queue that has run dry, an ask one of its members left open, an item of its that waits on a dead dependency. What it leaves open goes to the lead above it. A member that failed and a queue nobody is left to work are the swarm lead's, since only it can change the staff.
- `staff_swarm`, `swarm_finish` and topic `announce` stay with the swarm's lead. When a queue's lead stops, its queues fall back to the lead above it.
- Leads form a tree of whatever depth the work needs. A lead answers to the swarm's lead unless it names another lead with `under: "name"`; then it reads that lead's status as well as the swarm lead's, what it leaves open goes to that lead first, and that lead can reach the members under it with `tell_worker`. `under` names a member that leads queues, not the swarm's lead and not a member that does the work, and leads cannot answer to each other in a circle.

Whether a queue gets a lead of its own is the main agent's decision, not a default: the script declares it, or the main agent adds one to a running swarm with `staff_swarm({add: ["name"], leads: ["queue"], under?, model?})`, which announces it to the members already running. It needs a swarm lead, a queue has at most one, and a swarm small enough for one lead to keep fed does not need any.

`swarm` resolves to `{stop, result?, turns, members: [{name, lead?, leads?, added?, queue?, turns, status, error?, note}], queues?, posts, lastSeq, hasMore}`. `queues` maps each consumed queue to its item counts. `posts` holds up to the first 50 posts of the swarm; read further ones with `readBoard`. `note` is the start of the member's last final answer: up to 2000 characters, fewer in a swarm of more than 20 members so that the whole result still fits a script value (40000 characters shared by all members).

| `stop` | Meaning |
| --- | --- |
| `finished` | The lead called `swarm_finish`; `result` holds its verdict |
| `quiet` | No lead, and everyone went idle |
| `max_turns` | No lead, and a member that had used its wake-ups still had messages to read |
| `failed` | No lead, and a member failed |

If the lead fails, or the swarm runs out of the workflow's agent-call budget, `swarm` resolves to `null`, or rejects with `onError: "throw"`.

- `members` and `lead` take `{name, role?, harness?, model?, reasoningEffort?, workflowTool?, workspace?, queue?}`, and a member other than the lead also `leads?` and, with it, `under?`: 1–512 at the start, the lead included; 512 live members at once and 2048 over its life once the lead has added some (retired and failed members count only against the lifetime total). Names use 1–40 letters, digits, `_`, `.` or `-`, cannot be `all`, `main`, `script` or `system`, and are dedicated to this swarm: `agent`, `receive` and `waitFor` reject them.
- `maxTurns` bounds the wake-ups of each member after its first turn: default 6, range 1–4096. Every turn counts toward `maxAgents`; reserve `members × (maxTurns + 1)`.
- The lead is not bound by `maxTurns`, and neither is the lead of a queue: it coordinates for as long as the swarm runs. What bounds its turns is the gap in which results are gathered for it (above), so a large swarm cannot spend a lead turn on every result. Its turns still count toward `maxAgents`.
- The main agent steers a running swarm with `set_goal`, with `ask` (an answer or an action it waits for), with `tell_worker` (words put into a member's running turn, or left for its next one) and by changing the work and the staff. Users reach a member with `/workflow post @parser also cover CRLF input`, and leave a note for whoever reads the board with `/workflow post <text>`.
- On replay the swarm continues from its record: completed turns are not run again, a turn cut short by a pause or restart is retried in the member's own conversation, and members the lead added stay. The definition (key, task and member bindings) cannot change across replay.
- Put ownership in the roles: who plans, who owns which files, who verifies and how. A lead that only assigns and judges is a reasonable default. For a batch of items, deliver optimistically: a member delivers an item once the check the item names passes, without a reviewer for each one, and a quality team of its own (about one member for every two to four workers, on another model or a higher effort) hunts for bugs in what was delivered, reads it and uses it, and adds what it finds as new items. Check independently before delivery only what would spread before a mistake is found: defaults and switches, numbers and conclusions other work builds on, the checks and expected outputs themselves; see [optimistic landing](#optimistic-landing-and-the-quality-team). Give members that edit the same repository concurrently their own [workspace](workflow-worktrees.md).
- The member prompt puts a member's own part first: a lead is told to plan and judge and not to do the work itself, what makes a good item (one result a single member can finish and check in one turn, with the check stated) and how far ahead of its members to keep a queue; a queue consumer is told to finish and check an item before completing it, to stay inside it and to report what it finds outside as new work. A lead whose swarm has queues is also told that delivery does not wait for a reviewer and that looking at delivered work is planned like any other work, and every lead to give the repair of what all members depend on to one of them. A queue consumer is told to deliver once its item's check passes, not to weaken a check to pass it, to put what it finds into the queue of the members that do that work, and to leave such a repair to the member given it. The roster lists members of the same standing, queue and role on one line.
- Asks cost turns: every ask wakes the member asked, and its answer the asker. A note costs none. The member prompt tells members to note what a note would do and to post no acknowledgements; `maxTurns` is the hard bound for members, and the gathering gap is the bound for a lead.

Use `parallel` for a fixed split with no interaction, `discuss` when positions must be argued to a conclusion, and `swarm` for a dynamic batch of queued items and for work that has to be adjusted as it goes, where members need to ask, hand over and verify each other's work.

### Persistent members

Add `member` to an `agent()` call to keep a logical agent across turns. Calls without it retain the independent-task behavior. A member belongs to one workflow and pins its original harness, model, configuration, workspace and authorization. Different members can use different harnesses.

```js
const proposal = await agent('Propose a design. Save your decisions with checkpoint.', {
  key: 'proposal', member: 'designer',
});
return await parallel([
  async () => {
    await receive('designer', { key: 'feedback' });
    return await agent('Revise your proposal using your inbox and checkpoint.', {
      key: 'revision', member: 'designer',
    });
  },
  async () => {
    const review = await agent('Review this proposal in at most 4000 characters: ' + proposal, {
      key: 'review', member: 'reviewer',
    });
    await send('designer', review, { key: 'deliver-review' });
    return review;
  },
]);
```

The five persisted abstractions are:

| Abstraction | Contract |
| --- | --- |
| `DurableAgent` | Stable member identity, current checkpoint, committed/active turn and wait condition. One active turn per member. |
| `SessionBinding` | The authorized execution binding and native session/thread ID. Every later turn resumes that same conversation. |
| `AgentTurn` / `TurnAttempt` | Immutable logical input, predecessor turn, starting checkpoint version and input message IDs; each retry has a fresh attempt ID. |
| `AgentCheckpoint` | Versioned JSON work state, native session reference and result reference. Progress can be saved before a turn completes. |
| `AgentMailbox` / `WaitState` | Durable messages and receive receipts. Waiting releases worker resources; the script interpreter remains bounded by the workflow deadline. |

`send(member, text, {key})` queues up to 4000 characters for an existing member and returns `{messageId}`. Script messages come from `main`; a script cannot choose another sender. `receive(member, {key})` resolves with up to 16 `{id, from, text}` messages, or waits if none are available. Both are JSON-only sandbox calls and must be awaited. Agent and mailbox keys share one per-run namespace. Script sends are deduplicated across replay; reusing a send key with different content fails.

A receive reserves a stable batch. It does not acknowledge the messages. The next turn for that member receives the batch in its context; successful turn completion atomically saves a checkpoint and acknowledges those messages. Failed or cancelled attempts leave them available to that same logical turn. Messages arriving before a wait are delivered immediately; arrivals after a wait wake it. A member can have only one outstanding receive. Follow it with the next member turn to acknowledge the batch. The script controls which event starts each turn; there is no autonomous member loop.

Members can use their scoped CLI to call:

- `read_context`: how things stand for them now: their checkpoint and `checkpointVersion`, the fixed input batch of the turn, the goal and the status notes in force, the to-dos that wait on them (`todos`, and `deferred`), their open asks (`asked`), the board digest and their claim.
- `checkpoint` with `{operationId, expectedCheckpointVersion, state}`: save up to 16000 characters of JSON work state. Record progress, decisions, next steps and artifact paths. This does not finish the turn or acknowledge input messages.
- `ask`, `answer` and `note`: speak on the workflow's board (see [asks, answers and to-dos](#asks-and-answers)). An ask and an answer are delivered to the one member they are for; there is no private member-to-member message beyond that, and what members tell each other is on the board for the rest to read.
- `defer_todo` with `{operationId, id, note, minutes?}` and `pass_todo` with `{operationId, id, to, note?}`: put off or hand on a [to-do](#to-dos) they hold.
- `resolve_post` with `{operationId, seq, note?, see?, reopen?}`: mark its own posts and the posts that name it as [resolved](#resolved-posts) once they need nobody any more.

Worker operation IDs are scoped to the logical turn and deduplicated across attempts. Stale attempt credentials cannot update checkpoints or send messages. The main agent can inspect the latest work state with `read_checkpoint({member})`, and can leave a member a message with `tell_worker` (or ask it with `ask`), including while paused or interrupted; a message left that way does not resume a paused workflow. Members cannot change their execution binding, mutate another member's checkpoint, or create more workers.

Checkpoints, waits, message receipts and turn state are committed together in the bridge's SQLite workflow record. A progress checkpoint survives interruption. Recovery continues from the last saved work state and the backend's persisted native conversation, not a process snapshot. Native transcripts and external file changes are not part of the SQLite transaction. Verify uncertain side effects on retry; delivery and retries do not imply exactly-once external execution. A missing or replaced native session fails visibly rather than silently starting an empty conversation. The bridge records native IDs but relies on the backend's transcript storage and retention.

After a restart, a workflow that was running is replayed automatically (see [Restart recovery](#restart-recovery)); others remain `interrupted` until explicit `replay_script` or `/workflow resume`. Replay reconstructs the script from its beginning, reuses completed turns and receive receipts, then continues pending waits or retries the interrupted turn in its original native session. Persistent turn reuse validates the original request and predecessor chain; the stored input fingerprint includes the checkpoint version and message IDs. Rewriting committed history, skipping its predecessor, or changing a member's execution binding requires a new member name. One-shot tasks without `workflowTool` still retry in fresh sessions; enabled callers retain their native session for child-result continuation.

Limits per workflow: 2048 members and 512 execution attempts per task including retries. The ceilings on messages (4096), receive receipts (2048), mailbox operations (8192), work items (4096), claims (8192), waits (2048) and each kind of keyed script call (2048) bound what is live at once, not what a run accumulates: while the script runs, settled entries move to the archive — board posts beyond the latest 256, consumed messages and receipts, completed and cancelled work items, ended claims, settled waits, acknowledged notices, and all but the latest 256 idempotency records and script keys. Counts in status include archived entries; `read_board`, `work_status({itemId})`, replayed `receive`, `waitFor` and `enqueueWork` calls, dependencies and repeated operations read the archive. Failed work items, unread messages and members themselves are not archived. The number of tasks is not limited: a task that finished more than ten minutes ago leaves the workflow state for an archive, together with its session and result artifacts. Status counts include archived tasks, task lists show the ones still in the state, and replayed calls, `inputs` and `read_artifact` read the archive. One-shot tasks that ran in a managed workspace are not archived. The kernel retains up to 256 recent checkpoints while preserving every member's latest recovery point. Existing workflow call, deadline, replay, output and process-pool limits also apply. Members and the work queue below are scoped to one workflow; they do not create a cross-workflow team.

### Work items and claims

Work items persist independently of members. A script enqueues authorized work and starts persistent members; members actively claim items through their scoped CLI. The bridge atomically assigns an available item and stores ownership, lease and saved progress in the same SQLite workflow record. Work progress belongs to the item, so another member can adopt it after interruption.

```js
await enqueueWork({
  key: 'fix-parser', title: 'Fix parser handling of empty input',
  input: { issue: 'Empty input throws instead of returning an empty result' },
  resources: ['worktree:parser'], maxAttempts: 3,
});
return await agent('Claim work, read saved progress, implement and verify it, then complete_work.', {
  key: 'consume', member: 'developer',
});
```

For multiple consumers and recovery, use [the queue example](../workflow-definitions/scripted/examples/work-queue.js). Its arguments are `items` (enqueue objects), `members` (`{name, harness?, model?}`), and `consumerPrompt` (task-specific handling instructions within the original goal). It catches member failures and lets successful members take further turns when work remains. A failed member cannot skip its original unfinished turn with a new key; explicit replay retries that turn in its original session. The example stops on failed items, no remaining consumers, or its eight-round limit. Independent one-shot agents cannot claim work.

Worker operations:

| Operation | Arguments beyond `operationId` | Result |
| --- | --- | --- |
| `claim_work` | `leaseMs?, queue?` | `{claimId, generation, leaseUntil, item}`, or `null` if nothing is currently claimable |
| `checkpoint_work` | `claimId, generation, expectedProgressVersion, state` | Persisted item progress version |
| `complete_work` | `claimId, generation, result` | Terminal completed status |
| `fail_work` | `claimId, generation, error, retry?` | Failed status, or pending when `retry: true` and attempts remain |
| `release_claim` | `claimId, generation, reason` | Pending status, or failed when attempts are exhausted |
| `work_status` | `itemId?` or `key?`, or `queue?, offset?, limit?`; no `operationId` | Item detail or queue summary. The summary splits the pending items of work into `claimable` and `blocked` (waiting on dependencies, on resources held by claimed items, out of attempts, or on hold), and counts apart `onHold`, `heldReady` (on hold with every dependency completed), `stuck` (waiting on an item that was cancelled or failed for good) and `gates` (conditions nobody has declared met, which are pending but not work). It reports the `flow` of the last hours; a claimed item names the `member` that holds it, a pending one lists in `waitsOn` the dependencies it still waits on with their status, and one on hold carries `held: {by, at, reason}`. The detail of one item adds `neededBy`, the unfinished items that wait on it |
| `update_work` | `itemId` or `key`, and `priority?`, `hold?` (`true` with `reason`), `assignee?`, `dependsOn?`, or `supersededBy`, or `cancel, reason?` | The item's `status`, `priority`, `hold` with `holdReason`, `waitsOn` and `assignee`; after a cancel also `blocks`, the unfinished items that depend on it; after `supersededBy` also `nowWaitOnIt`, the items moved to the replacement |
| `settle_work` | `itemId` or `key`, `result` | Declares a gate met, or an unclaimed item done: `released` lists the items this let out, `stillOnHold` the ones that only a hold still keeps back |
| `retry_work` | `itemId` or `key`, `additionalAttempts?` | A failed item returns to the queue with more attempts |
| `search_work` | `query, queue?, status?, limit?`; no `operationId` | Items whose key, title, input, result or error contain every word of `query` |

Each member can hold one active claim. Swarm members declared with a `queue` use that queue and cannot claim from another; other members may specify a queue and default to `default`. Within a queue, higher `priority` (-100 to 100, default 0) is considered first, with FIFO ties. `dependsOn` names up to 32 already-enqueued work keys, including keys in other queues. All prerequisites must complete successfully before a claim is possible; enqueueing prerequisites first prevents cycles. A failed/cancelled prerequisite produces an actionable pool failure; repair it and explicitly replay. Grants are bound to member, logical turn, execution attempt, claim ID and monotonically increasing item generation. The default lease is 120 seconds, with a 1–300 second range capped by the workflow deadline. Save progress before important boundaries and renew early enough for long tools or model calls. Lease expiry cancels the owning turn and requeues the item, unless its attempt budget is exhausted. Turn exit, pause, cancellation, binding invalidation and controller restart also release unfinished claims; saved item progress remains. Restart/pause never starts consumers automatically: explicit replay is still required. `claim_work: null` means end the current consumer turn; the script decides whether another round is needed.

Queue mutation IDs are scoped to the current execution attempt. Repeating the same operation returns its recorded response; different content under that ID conflicts. Retrying a claim does not revive an expired/completed grant, and repeating a `null` claim returns `null`; use a new operation ID for a later claim query. Repeating an already committed completion with its original ID is harmless. Old attempts, owners and generations cannot make a new submission or overwrite a result. This fences bridge state only: external tool/file side effects are not transactional and are not guaranteed exactly once.

`resources` contains explicit exclusion keys shared across all logical queues in this workflow. Items sharing a key cannot hold active claims simultaneously; for example, use one canonical `worktree:<path>` key for all items that edit that worktree. Keys are opaque, matched exactly and local to this workflow. The bridge neither creates worktrees nor enforces filesystem access. A stale external process may still produce side effects after lease loss; verify those effects before resuming uncertain work.

`origin` and `assignee` say whom an item is for. Without them an item goes to whichever member of its queue claims it first.

- `origin` is the key of an existing item whose delivered result the new one is about: a problem found in it, or work that follows from it. When `queue` is left out the new item goes to the queue of that item, and when `assignee` is left out it is assigned to the member that completed that item (the member at work on it, when it is still claimed). A completed item records that member as `doneBy`, which `work_status` and `search_work` show.
- `assignee` names the member directly. It need not exist yet, so a script can assign an item before the swarm that will consume it starts.
- An assigned item is kept for its member while that member can take it: it consumes the item's queue in a running swarm, has not stopped and has wake-ups left. Only that member is woken for the item, `claim_work` hands it to that member before the queue's other items whatever their priority, and other members are not offered it.
- An assignee that cannot take the item does not hold it back: any member of the queue claims it, and the answers of `enqueue_work` and `update_work` say so in `assigneeNote`. The same happens when the member was woken for the item and ended that turn without claiming anything: the scheduler clears the assignment, since it does not wake a member twice for the same work.
- `update_work({key, assignee})` gives an unfinished item to another member, and `assignee: null` returns it to the whole queue. Only whoever plans the queue can.

`origin` and a named `assignee` are part of the item's immutable input; the member `origin` resolves to is not, so replaying the same call answers with the same item.

`writes` names up to 16 paths (directories or files) that the item expects to change. It locks nothing. Members that each work in a worktree of their own do not need a lock, yet two items that change the same files conflict when the second one lands, and a `resources` key would serialize them even where they do not. Instead, the unfinished items whose paths overlap are reported as `writeOverlaps` wherever one of them is looked at: in the answer of `enqueue_work`, in `work_status({key})`, and in the item a member is given by `claim_work`. Each entry has the other item's `key`, `queue`, `status`, `title`, the overlapping `paths` and, when it is claimed, the `member` at work on it; claimed items come first, at most 8 are listed and `moreWriteOverlaps` counts the rest. Whoever plans the queue orders the two with `dependsOn` or splits them; a member that is given such an item settles with the other member who changes what.

Paths are compared as written, after dropping `./`, repeated and trailing slashes: a path overlaps itself and everything under it (`src/parser` overlaps `src/parser/lexer.ts`, not `src/parser-tests`), `.` is the whole tree, and relative and absolute paths never meet. `..` is refused. Two items are not reported when something already keeps them apart: one depends on the other, directly or through other items, or they share a `resources` key. Like the rest of an item's input, `writes` cannot change under the same key. The script's `enqueueWork` accepts `writes` and answers with `{itemId, key}` alone, so that a replay reads what the first run read.

Enqueue keys share the script's key namespace. Replaying the same key/input reuses its existing item and does not reset its result or progress; changing immutable input under that key fails. `maxAttempts` defaults to 3 and counts the attempts that failed through their member: a `fail_work`, or a turn that broke down while it held the item. Handing an item back (`release_claim`), a lease that ran out, a stop from outside and a restart return the item without using one up. An item that keeps coming back that way without progress is not retried for ever in silence: after three such rounds it is a `spin` [to-do](#to-dos) of whoever planned it. Main can use `enqueue_work` or `retry_work({itemId, additionalAttempts?})` with the usual workflow ID, operation ID and state version. Retry applies only to failed items, adds a default allowance of one (1–8 per request), and never resets the generation. Resolve the failure and explicitly replay as needed. Retry does not cause previously successful, cached consumer turns to run again: add a new round/member when all original consumer calls were already successful. Pending or claimed work prevents script success and main completion. Failed items remain visible for main review; the packaged example treats them as an error.

The main agent's `enqueue_work`, `ask`, `answer`, `note`, `resolve_post`, `set_goal`, `defer_todo`, `pass_todo` and `wake_me` only add to or replace one part of the workflow, and `staff_swarm`, `retry_work`, `update_work`, `settle_work` and `extend_deadline` check what they change against the state they commit on, so none of them takes `expectedStateVersion`: a workflow with many members commits several times a second, and a change that had to quote the current version would rarely land. They still need `workflowId` and a unique `operationId`; repeating a call with the same `operationId` and input returns the first result.

Use `/workflow work` for counts and ownership, or `/workflow work <key>` for resource keys, saved progress version/time and recent claim history. `/workflow status [member]` also shows queue progress and member ownership. Summary output omits input/progress/result payloads; authorized `work_status({itemId})` returns the full item. Queries are read-only and do not renew leases or restart execution.

Limits shared by all queues in one workflow: 4096 items, 8192 claim records, 32768 queue mutation records, 16 resource keys per item, and 64 MB serialized queue state. Each input, progress state and result is limited to 16000 JSON characters. Status defaults to 16 items per page (maximum 64); use `nextOffset` for the next page. A script run can make at most 128 queue calls, including status queries, independently of its agent-call budget. The queue is bounded and intended for work within one workflow, not an unbounded service queue.

### Queue-driven consumers

A swarm member declared with `queue` consumes that work queue. The bridge starts a turn for it when the queue holds work it can claim, resumes the same native session for later turns, and leaves it asleep when there is none. Waiting uses no worker process or process-pool slot. The bounded script interpreter remains active and the workflow deadline continues to run.

```js
for (const item of args.items) await enqueueWork(item);
await closeWorkQueue({key: 'production-finished'});
return await swarm('Handle the authorized work, preserve progress and verify the result.', {
  key: 'consumers',
  members: [{name: 'A', harness: 'codex', queue: 'default'}, {name: 'B', harness: 'codex', queue: 'default'}],
  maxTurns: 24,
});
```

- A queue member takes no opening turn: it starts with its first claimable item. An ask or a message for it before then starts it as well.
- Its prompt tells it to use `claim_work`, `checkpoint_work` and `complete_work`, and to end the turn when a claim returns `null`. It must not sleep or poll. One turn usually claims several items in a row.
- The scheduler bounds dispatch by the claimable items and the turns that have not claimed yet. A member that raced another may still receive no item; the same set of available work does not wake it twice.
- A queue member is also woken by what waits on it (an ask, a message, a to-do passed to it), and handles that before consuming work. A swarm without a lead can mix queue members with members that only answer what they are asked, and members can consume different queues; see [routed work](workflow-scheduling.md#routed-work-and-dependencies).
- A member's failed turn is retried once in its own session; when it fails again the member stops for this script run. Its claim is released and the other members take the work over; with a lead, the stopped member is the lead's to-do. A member whose claim lease expires loses the item, not its place. Explicit replay retries its unfinished turn.
- `maxTurns` bounds each member's wake-ups (default 6, up to 4096); raise it when work arrives in batches. Every turn counts toward `maxAgents`.

**Closure of each queue is explicit and permanent.** An open but empty queue waits for new input; a closed queue stops accepting items and drains the existing ones. A swarm without a lead ends only when every queue its members consume is closed and holds no unfinished item, and nobody has a message to read. It fails if it goes idle while work is still available that no member can take, or with failed or unclaimable items. A swarm with a lead ends on the lead's `swarm_finish` as usual; that everyone is idle is the lead's to-do.

Members can add work as well as take it: `enqueue_work({key, title, input, origin?, queue?, ...})` puts an item into an existing open queue: with `origin`, the queue of the item the work follows from, and otherwise the member's own. A member that finds a problem in delivered work names the item it came from as `origin`, and the repair goes back to the member that delivered it (see `origin` above); members put the key of their item in their commit messages so that a change can be traced to its item. A member adds what it sees that the goal needs and no item covers, without asking anyone first: the rest of an item that is too large, a problem found along the way, a step nobody planned, or the next batch when the queue has run dry and the goal is not met. An existing key returns `{itemId, key, existing: true, status}` instead of a new item, so members that report the same finding under the same key do not duplicate it. Items added by a member carry `by` in `work_status`. Script keys and member keys share one namespace. An existing `key` is not enqueued again, but two members rarely choose the same key for the same problem: before enqueueing, and before starting to investigate something, a member runs `search_work({query})` with words that describe it (a module, a symptom, a test name). The search covers every item of the workflow, finished and archived ones included, ranks key and title matches first, and returns each hit's `itemId`, status and the text around the match; `work_status({itemId})` returns the item in full.

**An item can be changed until it is done.** Work that has become pointless otherwise stays in its queue until a member claims it and gives it up, and the only way to put urgent work first was to have set its priority when adding it. `update_work` takes an item by `itemId` or `key` and one kind of change: `title`, `input`, `writes` and `resources` rewrite what the item asks while nobody has claimed it (the item keeps its key, its place and what waits on it, and counts the rewrite in `revision`; a member that had left the item alone is offered it again); `priority` (-100..100) moves it in the order items are handed out; `hold: true` sets it aside, where it keeps its place and its progress but is not handed out, and `hold: false` returns it; `assignee` gives it to one member, or with `null` back to the whole queue; `dependsOn` replaces the list of items it waits on (not while it is claimed, and never so that an item waits on itself); `cancel: true` withdraws it, with an optional `reason` that the item keeps as its error. A claimed item is neither rewritten nor cancelled: its member works from what the item said and is the one to stop, so tell that member (`tell_worker`, or an ask) and change the item once it has returned to the queue, or replace it (below). Cancelling does not cascade: the items that depend on a cancelled one can no longer be claimed, and the answer lists them as `blocks` for whoever cancelled it to decide. `retry_work` gives a failed item more attempts (1 by default, 8 at most) and returns it to the queue.

**Waiting is a dependency; a hold is a decision.** An item that has to wait for something names it in `dependsOn` and is handed out by itself when that is done, with nobody lifting anything. What it waits for is another item, or a *gate*: `enqueue_work({key, title, input, gate: true})` adds a condition that nobody claims, for what no member of the workflow does (an event outside it, a decision, a release, an approval), and `settle_work({key, result})` declares it met, with what was established as `result`. Whoever plans the gate settles it, or the member that added it. `settle_work` also ends the wait for an unclaimed item of work that was done some other way. When the item others wait on is a check and it did not pass, its member ends it with `fail_work`, not `complete_work`; a claimed item tells its member in `neededBy` what waits on it. `hold: true` is for an item someone decided to set aside, and it must say why (`reason`: what for, and what would bring it back). A hold is lifted only by `hold: false`, so it is the wrong tool for waiting: before gates existed, plans used it for "until this is pushed" and "until that verdict is in", and the items stayed held until someone went through the queue by hand. When every dependency of a held item has been completed since it was set aside, that is an `aside` [to-do](#to-dos) of the lead that set it aside (else of the lead that plans the item), which lists the items with their reasons; `heldReady` counts them. A gate that stays open for an hour, or that is all a swarm still waits for, is a `gate` to-do of whoever plans it.

**A plan is revised in place, not by re-issuing items.** An item nobody has claimed is rewritten under its own key (above). One that is claimed or done is replaced: `update_work({key: old, supersededBy: new})`, or `supersedes: [old, ...]` on the `enqueue_work` that adds the new item, makes every unfinished item that waited on the old one wait on the new one, withdraws the old one and records `supersededBy` on it. An old item that a member holds is withdrawn when that claim ends without completing it; its member is told by a message, and `tell_worker` reaches it at once. A completed old item keeps its result and only what waited on it moves. Naming an old key in `dependsOn` later means its replacement. Whoever plans the old item may replace it, and the member that added it while nobody has claimed it. A replacement that would make an item wait on itself is refused. An item that waits on a dependency which was cancelled, or failed with no attempt left, is never handed out as things stand: when that has lasted ten minutes it is a `dead` to-do of the lead that plans the item, and `stuck` counts such items. A swarm without a lead that goes idle with work waiting on an unsettled gate stays running, and the gate is the main agent's to-do at once; it ends when the gate is settled.

These belong to whoever plans the queue: the main agent, the swarm's lead for any queue, and the lead of a queue for its own. Any other member may only rewrite, cancel or replace an item it added itself, while nobody has claimed it, and settle a gate it added. None takes `expectedStateVersion`; of two changes to one item the later stands.

For concurrent producers, start the swarm, produce, close the queue, then await the swarm:

```js
const consumers = swarm(args.consumerPrompt, {key: 'pool', members: args.members.map(member => ({...member, queue: 'default'}))});
const items = await agent(args.planningTask, {key: 'producer', output: 'json'});
for (const item of items) await enqueueWork(item);
await closeWorkQueue({key: 'production-finished'});
return await consumers;
```

The [packaged consumer example](../workflow-definitions/scripted/examples/queue-swarm.js) accepts `items`, `members`, `consumerPrompt`, optional `maxTurns`, and `keepOpen`. By default it closes the queue after enqueueing the initial batch. With `keepOpen: true`, main must close it after additional authorized work arrives. Main CLI operations use the normal workflow ID, operation ID and expected state version. Chat controls for an existing workflow are:

```text
/workflow enqueue {"key":"extra-item","title":"Additional task","input":"Task details within the original goal"}
/workflow close [queue]
```

Enqueue accepts optional `resources`, `writes` and `maxAttempts`. These commands never create a workflow; when paused/interrupted they only persist the change. A restart keeps each claim for its member when the workflow resumes on its own: the member's next attempt continues the claim with the same `claimId` and `generation`, and a claim no member resumes within ten minutes returns to the queue. Workflows that wait for an explicit replay have their claims cancelled at restart; scheduling resumes with the automatic or explicit replay. `/workflow work` and `/workflow status [member]` display queue closure, pool state, turn budget, idle waits and stopped members, including before a member's first native turn. Ordinary messages do not enter workflow mode.

### Claim, fix and land

For a batch of independent fixes in one repository, let every member claim an item, work in its own worktree and land the result itself, instead of collecting candidates for one integration at the end.

```js
const landing = await configureLanding({ key: 'landing', checks: [{ argv: ['npm', 'test'], timeoutMs: 600000 }] });
const workspaces = await parallel(names.map(name => () => createWorkspace({ key: 'wt-' + name })));
const fixing = swarm('Claim one bug, fix it, commit, then submit_work.', { key: 'fixers', maxTurns: 16,
  members: names.map((name, index) => ({ name, queue: 'default', workspace: workspaces[index].id })) });
for (const bug of bugs) await enqueueWork({ key: bug.key, title: bug.title, input: bug });
await closeWorkQueue({ key: 'closed' });
await fixing;
```

- `configureLanding({key, checks, precheck?, protect?, batch?, target?})` names the private branch `bridge-workflow/<workflowId>/<target>` (default `result`) and the 1–4 commands every landing must pass. Calling it again replaces the configuration.
- A member with a worktree calls `submit_work({result?, waitSeconds?})` after committing; it needs no argument, and submits the commits of the worktree for the item the member holds (for an item of their own when it holds none). The call lasts as long as the member's worktree is needed and no longer: the commits are stacked on the branch head in the object database, with the worktree left alone, screened for protected paths and, when there is a `precheck`, checked out in the worktree and run through it; what fails is the answer, with the claim still the member's. Once they have joined the queue the call answers `{status: "submitted", key, targetCommit, headCommit, commits, worktree}`. The member does not wait for the queue: its worktree is back at `targetCommit`, the tip of the branch, without the submitted commits (`worktree: "kept"` says it could not be moved), and it claims its next item.
- `claim_work()` puts the member's worktree where the item it hands out starts and says so in `worktree`: `"tip"`, the tip of the landing branch, for a new item, and `"commits"`, the commits the queue turned back, for an item that came back (also when another member takes it up). Only a worktree that loses nothing by the move is moved. One with uncommitted changes, or with commits of its own that have not landed, is `"kept"`, and `worktreeNote` says why and where the item starts. The commits of a submission stay in the repository under `refs/bridge-workflow/<workflowId>/work/<head>` until they land, so they do not depend on the worktree they were made in.
- Submissions land in batches. Each one is first prepared on the member's side, side by side with the others: stacked on the branch head, screened for protected paths, and run through `precheck` in the member's worktree if there is one. It then joins the queue for the next train, by the IDs of its commits: the queue does not look at the member's worktree again. A train stacks the waiting submissions (at most `batch`, default 16, 1–64) on the branch head, in the order they were submitted, checks the stack out in a worktree of its own and runs `checks` once on it. The stack is made in the object database: each commit is merged onto it the way a pick merges it and committed again with its author and message, so stacking takes the same time however large the checkout and however slow its file system. Only what is not a plain line of commits (a merge, a message in another encoding) is picked in the worktree, as is everything under a Git older than 2.40. If they pass, the branch advances to the stack and every submission on it has landed.
- If a train's checks fail, the stack is bisected for the first submission that breaks them. The ones before it land, it gets `check_failed` with the output, and the ones after it ride the next train. The branch therefore only ever points at commits the checks passed on, and the number of check runs grows with the number of trains rather than of submissions.
- A submission that adds no commit to the stack takes no place in that search. When the branch holds all of its commits by the time its train stacks it (someone else landed the same change while it waited), it is answered `landed` with `commits: 0` at once, without a run of the checks. When the submissions below it on the train hold them, the stack is the same commit with it and without: it lands when they do, and rides the next train, where it is stacked anew, when they do not.
- `precheck` (1–4 commands, such as a build and the tests) runs in the member's own worktree and keeps a submission that is broken on its own off the trains, so bisecting is left for changes that only fail together. `checks` run only in the train's worktree, which keeps build outputs between trains; they cannot rely on files in a member's worktree, and must leave no untracked files behind. That worktree is beside the members', under the same directory. `train_directory` in the bridge's [`[workflow]` table](configuration.md#workflows-and-the-machine) names another directory for the trains, for instance one on a local disk when the worktrees are on a network filesystem: the checks then build at the speed of that disk. The train is a plain worktree there whatever the members' workspaces are, and nothing in it has to survive: when the directory is gone, the next train checks the commit out again.
- Both run with `GIT_OPTIONAL_LOCKS=0`, so `git status` in a check reads the index without locking it. A check that is stopped (its train makes way for a withdrawal or for a submission put at the head of the queue, or its time is up) is first sent `SIGTERM`, with everything it started, and is killed three seconds later if it still runs. A Git command that is killed outright leaves its lock file behind, and the reset that the train's next run starts with then fails on `index.lock` until the lock is ten minutes old and the engine removes it; a Git command that is asked to stop removes its lock itself. The variable does not cover every command: `git diff` still locks the index when it finds files whose times changed and whose contents did not, and so does whatever writes the index (`add`, `checkout`, `reset`, `stash`). A check should not run those in the worktree it is given, and a check that takes a moment to stop when asked should finish within the three seconds.
- `protect: [{paths, allow?}]` lists paths members may not change, such as expected outputs or the markers that say which cases count. A submission that changes, deletes or renames one is `rejected` with the files, before any check runs; worktrees listed in the rule's `allow` (workspace IDs) are exempt. Patterns are relative to the repository root: `*` and `?` stay inside one path segment, `**` crosses them, and a directory name covers everything below it. Since `allow` needs workspace IDs, call `configureLanding` again after `createWorkspace`.
- From the moment the commits join the queue the engine holds the claim of the item they are for (`claim.landing` in `work_status`; the item stays `claimed`, and `submitted` in the queue summary counts such items). When they land the item is completed with `result` (by default the landed commit) as the work of that member, and only then are the items that depend on it handed out. When the queue turns them back (a conflict on a train, a failed check, a train that gave up) the item returns to the member: it is assigned to it and handed out to it first, it keeps the queue's answer in `item.landing` (`status`, `reason`, the commits as `base..head`, which `claim_work` puts back into the worktree, and the report with the command output cut to its end), and the member is told. This does not use up one of the item's attempts. A claim the queue holds does not end with the member's turn, and a swarm whose members are all idle is not taken for stalled while the queue holds work.
- `conflict`, `check_failed` and `rejected` from the member's own worktree are answered by the call itself: the member keeps its claim, repairs the worktree and submits again. After a conflict or a rejection the worktree is exactly as submitted (`git rebase <targetCommit>` there shows the conflict to resolve); after a failed `precheck` it holds the commits that failed, stacked on the branch head. A worktree with nothing to land is answered `landed` with no commits, which completes the item the member holds.
- A member's next item therefore cannot build on commits that have not landed. Work that has an order is given one with `dependsOn`: the later item is handed out when the earlier one has landed. That includes two items of one member that change the same lines: made one after the other on the same branch head, they clash on the train like the work of two members.
- A script that returns while commits are with the queue is finished once they have landed or come back: its result waits for that. An item the queue turns back needs someone to take it up. A swarm wakes the member it is assigned to; a member run by a single `agent()` call has ended its turn and is not woken, so the script then fails and names the items that were turned back. Members that land code belong in a swarm.
- A `submit_work` without a claim is for a member that holds no item, such as a lead that lands its own commits; a member that holds one is told to name it. The engine adds a work item for the commits (`submitted-<commit>`, in the member's queue even when that is closed, assigned to the member) and follows them the same way. An item that comes back to a task that is no persistent member is assigned to nobody and waits in its queue.
- A submission that applies to the branch head but not on top of the others on its train is tried first on the next train; only a clash with landed work is reported as `conflict`.
- `withdraw_work({itemId or key, reason})` takes commits out of the queue before they land. The member that submitted them may call it, and so may whoever plans their queue: the main agent, the swarm's lead, the lead of the queue. A submission that waits leaves the queue. One on the train that runs is left out of it: when its commits are already in the stack, the check that runs is stopped and the train runs again at once with the others, since stacking costs next to nothing and a check that goes on with commits known to be bad costs the whole queue its time. The submission is answered `withdrawn`, which returns the item to its member like any other answer but `landed`, with who withdrew it and why in `item.landing.reason`. The call answers `{status: "withdrawn", commits}`; `{status: "landing"}` when the train has passed the checks and is moving the branch, so the commits land; and `{status: "absent"}` when the queue no longer holds the item. Bisecting only turns back the first submission that fails the checks, so one behind it that is known to be bad, or that makes the checks slow without failing them, rides every following train until it is withdrawn.
- `expedite_work({itemId or key, reason})` puts the commits of an item at the head of the queue, once their member has submitted them. It is for a repair the landing itself waits for (the branch fails the checks or everyone's `precheck` by itself, or a check is broken): behind the other submissions it would land after the ones it is to unblock. It is a call of its own, and not a way of submitting, because who decides it is rarely who made the commits: whoever plans their queue may call it (the main agent, the swarm's lead, the lead of the queue), and a lead may for commits of its own; any other member is refused and tells its lead. The submission moves ahead of everything that waits in the queue, behind the ones put at the head before it. Those ride a train that carries nothing else, so one run of `checks` lands them and nothing of theirs is bisected with the rest. A train that runs with other submissions, and is not yet moving the branch, stops (`preempted` in the ledger), whether the repair rode it or waited behind it: its submissions keep their order behind the head of the queue and are stacked and checked anew on what the repair landed, which landing the repair first would have required in any case. Nothing is skipped for such a submission: it has passed `precheck` in its member's worktree and passes `checks` on its train like any other. Each use costs every other submission one run of the checks, so it is not for work that is merely important. The call answers `expedited`, `landing` when the train that carries the commits is already moving the branch, and `absent` when the queue holds no commits of the item (not submitted yet, or answered already). Who asked and why is kept in the ledger and shown on the dashboard.
- A call waits for the rebase and the `precheck` for at most `waitSeconds` (180 by default, 0–3600). When they take longer they go on without it, and the call answers `{status: "preparing", operationId, seconds}`; the member calls again with the same `operationId`, and a call it makes under another `operationId` meanwhile waits for the same submission. The answer is kept until a call has returned it: a repeat of the `operationId` reads it again, and so does a call that submits the same claim under a new `operationId` before the member has read what became of it. A shell call that is cut off therefore loses nothing. The queue itself is held in memory: a restart returns every item it held to its member with `status: "lost"` in `item.landing`, and so does a lease the queue stopped renewing; the commits are untouched and are submitted again.
- A train that fails for a reason of its own keeps its submissions and runs again; nobody is sent back to rebase, precheck and queue once more for it. A Git command that failed in the train's worktree (another process holds a lock there, or the file system hiccuped) is waited out with growing pauses, about eighteen minutes in all, and only after the last one do the submissions get the failure. A lock file in the train's own Git directory that has not changed for ten minutes was left by a process that is gone and is removed; an index that cannot be read twice in a row is written anew. A branch that moved while the checks ran is looked at first by the next run, which adopts the outside commits and stacks the same submissions on them, or halts. A check that fails or runs out of time is an answer and is not repeated. Meanwhile `configure_landing()` shows `retrying` on the branch, and the main agent hears what happened with the next reports (`landing_attention`). Members must not run commands in the train's worktree: `git status` there locks its index for as long as it scans the tree, and every train stops for that long.
- Only the queue moves the landing branch. It remembers the commit it last landed and writes a reflog entry for every move (`bridge-workflow: landed 3 submission(s), …`). When a train finds the branch somewhere else — someone committed to it or ran `update-ref` — it looks at the outside commits first. If they were added on top of the last landed commit, leave every protected path alone and pass `precheck` and `checks`, the queue adopts them and carries on. Otherwise the landing stops: the submissions in the queue stay there and board again once the branch is settled, and a new `submit_work` is answered `halted`, with the member keeping its claim and its commits. Either way the main agent is woken with a `landing_attention` event.
- A checkout that is on the landing branch does not hold the queue up. Before the queue moves the branch (a landing, or `branch: "restore"`) it detaches the HEAD of every worktree of the repository that has the branch checked out, on the commit that worktree was on and without touching its index or its files; the worktree's reflog says so. Members are told to read the branch with `git log`, `git show` or `git checkout --detach` and not to switch to it: a checkout left on the branch would show whatever lands as a staged change that undoes it, and its next commit would take that work out of the branch again.
- The main agent changes the landing while the workflow runs with `configure_landing({checks?, precheck?, protect?, batch?, reset?, branch?})`; no replay is needed. `checks`, `precheck` (`[]` for none) and `batch` replace the script's settings, `protect` adds rules to the script's (`[]` for none added), and `reset: true` drops the earlier changes first. The changes are stored apart from the script's configuration, so a later `configureLanding` in the script does not undo them. Without options the call reports the settings in force, which of them are `overridden`, and each repository's branch: its head, the submissions `waiting`, the `train` that runs now, and `retrying` or `halted` when that is so; `usualCheckSeconds`, how long a run of the checks that passed has usually taken lately; and `recent`, the latest five trains in short.
- Every run of a train is written to the landing ledger: the submissions it carried (item key, member, commits) and what became of each, and every run of the checks (on the stack after how many submissions, for how long, whether it passed, and which command failed). `configure_landing({trains: N})` adds the latest `N` trains (1–100) to its answer in full; it changes nothing and still answers after the workflow has ended. The ledger is the `landing_trains` table of the workspace database, 500 trains for each workflow. A train that ran no check and answered nobody is not written down.
- A run of the checks that takes far longer than the ones that passed lately (three times the usual time and at least five minutes more, measured on the latest twenty runs under the same commands) is reported to the main agent while it still runs, as a `landing_attention` event that names how many submissions the commit under test holds and which of them are suspect: the ones no run of the usual length on this train included. A check that only gets slow is not a failure, so the submission that causes it is not turned back by itself; `withdraw_work` takes it out. A command that runs past its `timeoutMs` is not bisected: every submission of the train goes back to its member.
- New `checks` or `precheck` are first run on the landing branch as it is, and the call waits for them. If the branch does not pass, nothing is changed and the answer carries `refused` with the output: on a branch that fails its own checks every submission would be blamed for it. Land the repair under the current checks, then change them. Put the scripts the checks run under `protect` too; otherwise a submission can loosen the checks it is judged by.
- `branch: "restore"` puts a halted branch back on the last landed commit and keeps the outside commits under `refs/bridge-workflow/<workflowId>/outside/<commit>`; `branch: "adopt"` has the queue vouch for the branch as it is.
- `createWorkspace({key, repo})` makes the worktree from another checkout than the workflow's cwd: `repo` is the absolute path of its root. The landing branch is created in that repository.
- `createWorkspace({key, isolation: 'clone'})` gives the member a repository of its own instead of a worktree, so its Git commands cannot reach other members' refs, stash or locks; see [worktree or clone](workflow-worktrees.md#worktree-or-clone).
- `createWorkspace({key, isolation: 'wsfs'})` gives the member a worktree without a checkout: its files are read from the object database as they are opened, so it is ready in a fraction of a second on a repository of any size, and landing writes no file in it; see [workspaces served from the object database](workflow-worktrees.md#workspaces-served-from-the-object-database).
- Nothing is pushed and the original checkout is not touched. Limits: 1024 worktrees per workflow, plus one train worktree per repository, removed with the last member worktree.

The [packaged example](../workflow-definitions/scripted/examples/claim-and-land.js) takes `items`, `checks`, and optional `members`, `precheck`, `protect`, `repo`, `prompt` and `model`.

#### Optimistic landing and the quality team

`precheck` runs in every member's own worktree at once; `checks` run on the train, one train at a time, and everyone who is waiting waits for them. The default for a swarm that lands its own work is therefore to land optimistically:

- Put what a submission must pass on its own into `precheck`: the build, the tests it affects, and the full tests where they are affordable. Leave `checks` one cheap command on the merged tree, a build or a type check. It catches the most common way two sound changes break each other: one changes a type or a signature the other still uses. The shorter the wait, the less the branch moves under a submission, and the fewer conflicts and resubmissions there are.
- Two submissions that each pass can still turn the full tests red together, and from then on every member's `precheck` fails on someone else's change. Give one member with a worktree the landing branch to watch: with `wake_me` it runs the full tests on the branch head from time to time, bisects a failure to the commit that caused it, lands a revert of that commit with `submit_work`, and adds the reverted work to the queue again with the failing output. The lead announces that the branch is red and who has it; the others do not each repair it. A member is told how to tell its own failure from the branch's: run the same command on `targetCommit`. Each wake-up of the watching member counts toward `maxTurns`.
- A file every member changes in the same place (an append-only ledger, a registry of switches, an index, generated output) lets one submission of a train land and returns the others as `conflict` on the next. Keep members out of it: each adds an entry file of its own, named after its item, and a command generates the summary from the entries. Put the summary under `protect` and `allow` only the worktree of the member that regenerates it. Whether the summary is up to date stays out of `precheck` and `checks`, or every submission would be held up by it.
- Quality is kept by a team that works after the landing: queues such as `hunt` (look for bugs in what landed and add tests that reproduce them), `read` (read the landed code for duplication across commits, inconsistent definitions and weakened tests) and `use` (use the product the way its users would), with a lead of their own when there are several, which plans from the landing branch's log and the completed items. What they check is the delivered work itself, by trying it (running it, using it, redoing the step a conclusion rests on), not what was written about it: a review of a report, or a check of another check, finds nothing a user of the work would meet, and each such item breeds more of its kind. Its members run on another model or a higher effort than the workers and do not repair anything: they search for an existing report, then add the finding with `origin`, the key of the item it was found in, and with how to reproduce it and the evidence. The finding goes to that item's queue and to the member that delivered it, which is woken for it alone and claims it before other work; when that member has stopped or has no wake-ups left, another member of the queue takes it. A finding whose item cannot be identified names the workers' queue instead.
- Before the landing, only what would spread before a mistake is found is checked: a default or a switch that flips, a number or a conclusion other work will build on, the check scripts and expected outputs themselves. Put those paths under `protect` and `allow` only the worktrees of a few gatekeeping members on a stronger model; a change to them is added to the gatekeepers' queue, and they land it themselves once they have checked the evidence.

Put the full tests back into `checks` only where a wrong landing costs far more than the wait, such as a branch that is published as it lands. Of this the engine enforces `protect`, and it returns a finding to the member whose work it is about: an item enqueued with `origin` goes to the queue of the item it names and to the member that completed it. That rests on the finder naming the right item, which the key in the commit message makes possible and nothing checks. The rest is what the script's roles and the main agent's guide ask for: the queue does not run tests after a landing and does not revert anything.

### Nested workflows as a worker tool

Set `workflowTool: true` on each caller that may delegate. Omitted or false means no tool instructions and server-side rejection of `run_workflow`. Each child script makes this choice independently for its own workers; the flag is never inherited automatically. `consumeWork` accepts the same flag per member. Direct-mode agents receive neither workflow instructions nor a workflow binding, and cannot enable the capability themselves.

```js
return await agent(args.task, {
  key: 'designer', member: 'designer', workflowTool: true,
});
```

The enabled worker can run the following CLI with a JSON file:

```sh
node "$AGENT_WORKFLOW_CLI" workflow run_workflow --input-file child.json --json
```

```json
{
  "operationId": "design-review-1",
  "key": "design-review",
  "goal": "Review the proposed design within the original task",
  "plan": "One reviewer on the caller's harness/model, without delegation; return its findings.",
  "script": "return await agent(args.proposal, {key:'review', workflowTool:false});",
  "args": {"proposal": "Design and review criteria..."},
  "checkpoint": {"next": "Use the review to finish the design"}
}
```

`run_workflow` accepts `operationId`, `key`, `goal`, `script`, `plan`, and optional `args`, `name`, `execution`, `maxAgents`, `maxConcurrent`, `timeoutMs`, `checkpoint`, `parentQueue`. It uses the same script API and harness/model selection as the root. No profile, credential or environment overrides are accepted. The caller must already have a recorded native session. The child goal includes the original authorized goal; delegation does not expand authorization.

**This is a durable asynchronous tool call.** The first response is `{workflowId, key, status: "waiting", action: ...}`. The worker must end its turn immediately; it must not poll or block a shell waiting for the child. The bridge stops a caller that has not yielded after 30 seconds. The yield text is not committed as the parent's final answer. Once its process exits, the child runs, using the released concurrency slot. The parent then resumes its original native conversation with `workflows.call` containing `{ok, result, resultRef}` or `{ok:false, error}`, plus `workflows.checkpoint`. These fields are also available through `read_context`. The parent finishes the original task after consuming them. This works with one worker slot.

Keys identify child calls within the parent task. Repeating the same key/input returns the saved status or terminal result, including failures. Changed input under a key or a reused operation ID with different content conflicts. To intentionally retry a failed child call, use a new key and operation ID. One parent task may have only one outstanding child. The checkpoint accepts at most 16000 JSON characters. Active work claims are released when the parent yields; save item progress first and recheck/reclaim on continuation. An old claim cannot be reused.

Children have their own members, mailboxes and work queues. Explicit `parentQueue: true` grants only `enqueueWork({queue:"parent", key, title, input, ...})` into the immediate parent's queue. Use `target:"parent", queue:"reviews"` to select a named parent queue; the existing `queue:"parent"` syntax selects its default queue. This grant does not allow consumption, closure, arbitrary workflow access or root control. The parent must keep its queue open until its producers finish. Keys in that queue are shared by all its producers; coordinate them to avoid conflicting inputs. See [the nested example](../workflow-definitions/scripted/examples/nested-workflow.js) for independent per-worker flags.

The tree shares root worker concurrency, task budget and deadline. Child limits can reduce these allowances. There are at most three child levels and 256 child workflows per root. The parent continuation counts as another attempt of its original task. Completed child results and plans remain inspectable artifacts; only the root's plan and final event are sent to the chat.

Pause, cancellation, binding changes and deadlines apply to descendants. After a restart, root replay (automatic or explicit) reconstructs the waiting parents and paused/interrupted child scripts; it does not rerun completed child calls. Recovery retains native sessions, pending child IDs and checkpoints. Root completion requires descendants to be finished. Local state recovery does not guarantee exactly-once external side effects.

### Discussion example and native acceptance

[The A → B → A example](../workflow-definitions/scripted/examples/discussion.js) demonstrates the low-level mailbox protocol with a fixed speaking order; use `discuss` when members should choose whom to address. It creates two persistent members. A proposes a design, B reviews it, and A revises its original proposal using B's mailbox message. It returns all three documents and validates the response fields. Supply these script arguments:

```json
{
  "subject": "a cache with a 60-second TTL; prevent a delayed refresh from overwriting a newer value",
  "designerHarness": "codex",
  "reviewerHarness": "codex",
  "reviewId": "review-1"
}
```

Optional `designerModel` and `reviewerModel` select models supported by those harnesses. Keep the member bindings and `reviewId` stable on replay. By default the discussion runs to completion. Set `waitForStart: true` to wait at B's inbox after both members are created; a main-agent `tell_worker` to member `B` starts the review. If the workflow has been interrupted, explicitly replay it after queuing the message. A's inbox wait then receives the review, and its successful revision consumes that receipt.

The opt-in acceptance runner uses real Codex, Claude and Pi CLIs in the current authorized bridge profile. It calls model services and can incur usage costs. From a source checkout with dependencies installed and `dist/cli.js` built:

```sh
npm run build
npm run test:workflow-native -- --output /absolute/path/outside-the-repository/native-acceptance
```

Use `--backends codex` to limit the backends, and `--scenarios memory,interrupt,discussion,queue` to select cases. The default scenarios are memory, interrupt and discussion; opt into `--scenarios queue` for the three-consumer queue test or `--scenarios consumers` for queue-driven wakeups, or `--scenarios nested` for nested tool execution with one process slot. The discussion uses the first selected backend for A and the second for B, or the first for both if only one is selected. The runner uses native configured defaults without injecting a model service override, copying credentials, or switching profiles; `--model <id>` runs every worker of the selected cases on that model instead, child workflows included, unless a script names another. The observed model is recorded when the backend reports it. Missing native authentication is a failed acceptance prerequisite, not a passing test.

Additional nested lifecycle cases run with `--scenarios nested-recovery,nested-cancel,nested-queue,nested-before-yield`. All use one native worker slot in an isolated controller/database:

- `nested-recovery`: parent, middle caller and persistent leaf are three native sessions. Pause after the leaf checkpoint, exit the controller, explicitly replay in a fresh process, and require all three original sessions and the checkpoint/result to survive.
- `nested-cancel`: cancel while the leaf is running. Require all three workflows and tasks to stop, zero process slots, rejection of a late checkpoint, and no further dispatch or main-chat wakeup.
- `nested-queue`: a child planner produces four values and enqueues work into its parent's queue. A persistent consumer completes each item once; explicit closure lets the swarm drain and return.
- `nested-before-yield`: close the controller directly after a parent commits its child, before it yields. The workflow was running, so the new controller replays it on its own: that replay must execute that same child and return its result to the original parent session. A controller shutdown must not convert the accepted child into a permanent cancellation.

These recovery cases use controlled controller shutdown. Opt into `--scenarios nested-crash` on POSIX to SIGKILL the isolated controller immediately after the native parent yields, before its pending child runs. The launcher requires the expected crash signal and saved boundary evidence, then starts a fresh process, which replays the running workflow on its own, and verifies the original parent session and child result. This case waits for the native turn to exit before killing the controller; it does not kill the shared Codex daemon or test recovery of an active native turn.

`packages/workflow-engine/tests/crash-recovery.test.ts` also exercises six deterministic SIGKILL boundaries with real SQLite storage and controlled workers: child-call commit before yield, child-result commit before consumption, uncommitted child insertion, uncommitted child completion, claimed work with saved progress, and completed work. It checks transaction rollback, database integrity, explicit replay, deduplication, progress retention and rejection of stale attempts/claim generations. These are controller-process crashes, not machine power loss; external tool side effects still require idempotency checks.

The runner covers:

- **Nested workflow:** an explicitly enabled native parent calls `run_workflow` and ends its turn. Its child runs a leaf without the tool and verifies that the CLI rejects delegation. With a single process slot, the parent must resume the original native session, receive its checkpoint and child result, and produce the final answer. Child events must not wake the main agent.
- **Native memory:** a member memorizes a random, non-secret marker and replies `READY`. After the controller exits, a fresh process explicitly replays and asks the same native session to recall it. The marker is absent from the recall input and saved checkpoint; neither turn may use tools.
- **Interrupted work:** a member saves `state.stage = "armed"` through the actual worker CLI, then starts a foreground sleep. The controller pauses that attempt. A fresh controller replays the same logical turn and native session; the saved checkpoint tells it to finish without repeating the checkpoint or sleep.
- **Discussion:** the packaged example waits with both inboxes persisted. A fresh controller queues B's wakeup and explicitly replays. Completed proposal/bootstrap turns are cached, B reviews, and A consumes the review and revises. Both native IDs must remain unchanged and both receipts must be consumed.
- **Consumer scheduling:** three native members consume ten items with one interruption and takeover. The controller verifies zero occupied/queued process-pool slots while the open queue is empty, appends five items and closes it. Newly dispatched turns must resume prior native sessions; all fifteen results must be correct.
- **Work queue:** the packaged queue example starts three native members for ten arithmetic items. Each runs a local helper through its real shell tool and worker CLI. A saves partial progress and is interrupted; B and C adopt the work and finish all items. Checks require ten completed claims, preserved partial progress, a new generation/owner, and rejection of the revoked worker's late submission. This case uses one isolated controller; kernel and runtime tests cover lease expiry and restart separately.

Artifacts include `summary.json` plus each case's `before.json`, `result.json`, process logs and observations. They record process IDs, native session IDs, checkpoint/attempt state and final outputs. Inspect the actual proposal, review and revision for design quality; the automated checks establish the protocol and required fields. Keep this directory private because logs and model responses may contain local paths and conversation content.

These tests restart only isolated test controllers and databases. They do not restart a production bridge or the shared Codex daemon, and do not certify recovery from arbitrary machine crashes, backend transcript loss, or exactly-once external side effects. Normal CI continues to use controlled adapters; native acceptance is run explicitly.

### Replay and lifecycle

`replay_script` requires the usual `workflowId`, unique `operationId` and current `expectedStateVersion`. It optionally replaces `script`, `args` or `execution`; changes to any of these require an updated `plan`. Each replay publishes its plan again and restarts the function from its beginning. Completed calls are reused by a fingerprint of **key, prompt, output mode, resolved worker binding, root binding, goal, workflow definition and the digests of any `inputs`**. Changing execution order alone does not invalidate unrelated calls. For independent calls, changing a prompt or harness reruns that call in a fresh worker session; downstream calls rerun when the data in their prompts or referenced inputs changes. Ordinary `agent()` calls do not cache failed, cancelled, interrupted or waiting-for-input results. Managed handles created by `startAgent()` retain terminal outcomes as described in [scheduling controls](workflow-scheduling.md); use a new key to retry a failed handle. A named member retries the same logical turn in its original session; an independent task without `workflowTool` retries in a fresh session. Workflow-enabled tasks retain their native session and child-call history. The tool flag participates in the task fingerprint; it can be set independently on each new member turn. Up to eight replays and 128 total task attempts are retained per workflow.

This is result reuse, not replay of external side effects. File contents, network state, time and other implicit dependencies are not automatically hashed. Include relevant revisions or digests in prompts/keys when fresh execution is required. A task interrupted after a side effect may repeat that effect on replay. Worker tasks that modify shared files need an explicit ownership or serialization strategy. Queue resource keys can serialize claims when supplied; the workflow does not create worktrees or infer which files a task will modify.

For scripts, `/workflow pause` aborts the interpreter and cancels queued/running workers. Wait for worker cancellation to finish before `/workflow resume`; resume replays with cached completed calls. `/workflow cancel` cancels the whole workflow. `/stop` only interrupts the main agent's current turn: the workflow keeps running and later events wake the main agent again. Root session, engine, workspace or policy changes prevent reuse and further dispatch; main model or reasoning-effort changes do not. Target configuration changes invalidate matching worker cache entries. After restart, unfinished scripts are marked `interrupted`. Running roots resume automatically; the others accept `replay_script` or `/workflow resume` while the original root binding and deadline remain valid. At the deadline the running script fails with `Workflow deadline reached` and its workers are cancelled; it cannot be resumed or replayed. The main agent may still publish a report and `complete` with partial results, or the user cancels it; either releases the topic for a new workflow.

### Restart recovery

Bridge restarts are safe for running workflows. On startup the bridge:

1. **Marks** every unfinished workflow `interrupted`. It records when the outage began, using a heartbeat the kernel writes every 5 seconds.
2. **Replays automatically** each root workflow whose script was queued or running, but only when two conditions still hold:
   - the original root binding (main session, engine, workspace and permissions) is unchanged;
   - the deadline was not already reached before the restart.

   Completed calls are reused. A worker that was still running when the bridge stopped keeps running under its run host (Claude, Codex and the Pi CLI on Linux and macOS, see [runtime reference](runtime-reference.md)); when the replayed script reaches the same call (same key, prompt, inputs and binding for one-shot calls, the same logical turn for members), the bridge attaches to that process and the turn continues without restarting. Its workflow tool token stays valid, and the worker CLI finds the new controller through `workflows.sqlite.endpoint.json`: a call a worker makes during the outage, or before the replay has reached its turn, is not refused but repeated by the CLI until the new controller answers it, for up to ten minutes. A `submit_work` that was waiting for its checks when the bridge stopped is answered with a request to repeat it, and the CLI lands it through the new controller. Turns whose run host is gone retry; persistent members retry in their original native session. A turn in a managed worktree is kept in the same way. Its process holds the worktree while no bridge runs, the turn that continues it takes the worktree over, and a reviewer's frozen snapshot is verified when the review ends. Nothing else starts in that worktree before the process has ended: when no turn continues it, or another turn is given the worktree, the bridge ends it first. While it cannot confirm that the process has ended (it would not die, or its run host was killed and the agent outlived it), the worktree stays blocked and the bridge keeps trying. The turn of a worker that had started a child workflow and not yet ended it is not kept: its process is ended, and the worker continues in its native session once the child's result is there. A work claim stays with its member either way: a reattached process goes on using it, and a retried turn finds it in its work context. Surviving workers of a workflow that does not resume, or whose call the replay no longer reaches, are ended.
3. **Pauses the clock.** Time spent interrupted, including the outage itself, does not count toward the deadline. The deadline is extended once, when the workflow is replayed, whether automatically or explicitly.
4. **Reports** each outcome in the workflow's chat or topic: either that the workflow resumed, or why it did not.

A workflow that does not resume automatically stays `interrupted`, and `/workflow resume` replays it. The bridge does not retry it again on later restarts. This includes workflows that were paused, waiting for a binding decision, or had already finished their script before the restart.

**Why the chat is known after a restart.** The bridge persists the latest message per chat or topic in `workflow-origins.json`, next to `workflows.sqlite`. It uses this record to authorize the root session and to address replies.

**Upgrading from an earlier version.** Earlier versions kept this record only in memory and wrote no heartbeat. Their workflows therefore cannot resume automatically on the first restart into this version, until a new message arrives in that chat. Pause or let them finish before upgrading.

**Reading a journal written by another version.** Each event is applied by an exhaustive reducer; an event type this build does not know is never skipped. The affected workflow is reported once as `workflow-unreadable` in the bridge log, left out of scheduling, and any read of it fails with the journal position and event type. After a downgrade, workflows written by the newer build stay unreadable until you upgrade again; `replaceWorkflowState` (repair tooling) can overwrite such a workflow when dropping its journal is acceptable. Other workflows keep running.

Replay repeats interrupted work: side effects in the outside world (files, network) may be repeated, exactly as with an explicit replay.

### Scratch directories

Every worker runs with a temporary directory of its own instead of the machine's shared one. The bridge creates it, sets `TMPDIR`, `TMP`, `TEMP` and `AGENT_WORKFLOW_SCRATCH` to it, tells the worker where it is, and deletes it when its owner is gone:

| Owner | Kept | Deleted |
| --- | --- | --- |
| A member (swarm or `member:` session) | Across its turns, so builds and caches carry over. | When the member is retired, or the workflow ends. |
| A one-shot `agent()` / `startAgent()` worker | Across retries of the same task. | When its turn completes; otherwise when the task is cancelled or archived, or the workflow ends. |

Directories live under `<root>/<store>/<workflow>/<member>-<id>`, so a listing shows whose space is whose; `<root>` is `$TMPDIR/lark-wf-scratch` of the bridge process, or `LARK_WORKFLOW_SCRATCH_DIR`. Keep it on a local disk. A pass every minute, and one at startup, removes what belongs to finished workflows, retired members and workflows this bridge no longer knows, including what a crash left behind.

A scratch directory is private and temporary: a worker must put anything another worker or the main agent reads somewhere else, and a process it leaves running in the background loses the directory at the same moment. This directs well-behaved tools and attributes disk use; it does not stop a worker from writing to `/tmp/…` by name. With the [exec sandbox](exec-sandbox.md) enabled, the sandbox's writable temp directory follows the worker's `TMPDIR`, so the shared temp directory is no longer writable. Pi workers on a remote host or in a workcell keep that machine's own temp directory.

### Signals

On Linux a worker can signal only the processes it started, in this turn or an earlier one: `kill` or `pkill` aimed at another worker's process, or at anything else on the machine, fails with `Operation not permitted`, and the attempt is listed in `signal-cell.log`. A member that leads, the lead of a swarm or of queues of one, is not confined: like the main agent it can stop what a member left running. See [Signal isolation](signal-isolation.md) for what is confined, what is not, and how to turn it off.

### Writes

With `[workflow.worker_sandbox]` enabled in the bridge configuration, a worker that is not a lead can write only in its working directory, its scratch directory and the tool caches under the home directory, and can commit in its working directory; everything else, the main checkout and the other members' worktrees included, is read-only to it. Leads and the main agent keep what their profile allows. See [the exec sandbox for workflow workers](exec-sandbox.md#workflow-workers) for what that means for a script.

What the members of one workflow share outside their worktrees, such as a build cache or the state of a resource pool, the script names itself:

```js
await allowWrites(['/data/project/.scratch', '/data/project-ccache']);
```

`allowWrites([path, ...])` takes up to 32 absolute directories and opens them to every worker of the workflow that starts a turn afterwards, so call it before `swarm()` or `agent()`. Members a lead adds later get them too; no lead and no worker can add to them. The list stays as the script last set it, across replays as well, and `allowWrites([])` closes it. On a machine that does not confine its workers the call has no effect and is not an error, so a script can keep it. A read-only workflow cannot call it, and neither can the script of a child workflow, which a worker writes: the workers of a child workflow write where those of the workflow at the top do. Do not name a repository or its `.git`: that opens the other members' checkouts and the shared Git configuration again, which the sandbox is there to keep closed.

### Interpreter and execution boundaries

QuickJS/WASM runs the script with JSON-only host callbacks, no host objects, process, filesystem, network or module loader. `Date` and `Math.random` are disabled; pass such inputs through `args`. Each interpreter has a 256 MiB guest heap, 512 KiB stack, 100 ms synchronous slices, approximately 2 seconds of guest CPU and 100,000 promise jobs. There are at most four active interpreters per nesting depth, with four levels including roots (at most sixteen total). Waiting ancestors cannot exhaust the interpreter capacity needed by their children. Source, arguments, worker output and final output have bounded sizes (100,000 characters); status retains at most 50 log entries of 1,000 characters. A deadline/abort signal also terminates scripts awaiting an unresolved promise.

The interpreter boundary does **not** isolate workers: a worker is a normal configured harness under the original authorized profile, workspace and effective permissions. Scripts cannot select another profile or provide environment variables or credentials. Workers may perform only tasks authorized by the goal, and their final answers do not establish that tests or side effects succeeded. The main agent reviews evidence and reports validation limits.
