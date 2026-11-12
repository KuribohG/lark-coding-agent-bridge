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

The main agent's per-turn instructions cover what most workflows use: `agent`, `parallel`/`pipeline`, work queues, swarms, the board and the operations on a running workflow. The less common script functions (`discuss`, `reviewedAgent`, `speculativeAgent`, mailbox and event waits, task handles, worktrees and landing, nested workflows) are described only in the full guide, which any agent prints with `workflow guide` before using them.

### Asking the main agent about a running workflow

While a topic has a workflow, every ordinary message in it runs with that workflow's credentials. The main agent can answer "how is it going" from `status`, and act on a request to cancel a stuck worker (`cancel_task`), pause, post to the board, enqueue work or replay an edited script, without a `/workflow` command. Such a turn gets a short description of the operations and a few lines of state; `workflow guide` prints the full script guide when a replay needs it. It cannot start a workflow, and completion events are still delivered by their own wake.

### Changing the staff of a running swarm

`staff_swarm(swarm?, add?, like?, queue?, role?, brief?, revive?, retire?, maxTurns?)` lets the main agent adjust a running swarm without replaying the script; a swarm's lead has the same operation for its own swarm. `retire` names members that finish their current turn and are not woken again. `add` names new members, bound like an existing one (`like`, by default the first member that is not the lead) and taking its role and queue unless given; `revive` (`"failed"` or member names) puts failed members back to work by running their last turn again in the same native session; `maxTurns` raises the number of wake-ups per member. Use it when members have failed and queued work has nobody left to take it, or when the work has shifted from one queue to another. A swarm that has already ended cannot be staffed: that still takes a replay.

Claims no longer depend on members renewing a lease in time. While the turn that holds a claim is running, the engine extends the lease; the claim returns to the queue when the turn ends, is cancelled, or is stopped by the stall watchdog.

### Talking to a running worker

`tell_worker(target, text)` puts a message from the main agent into a worker's session while its turn runs, the way a user's follow-up reaches the main agent mid-turn. `target` is a task ID, a member name or the script key of a one-off worker. The result is `accepted` (the transport took it; the model reads it at its next step), `inactive` (no turn is running: name a persistent member on the board instead), `unsupported` (the worker's harness takes no input mid-turn) or `unknown`. The worker may answer each message once with `reply_main({text})`, which raises a `worker_reply` event and wakes the main agent; `worker_messages(target?)` lists the exchange. Use it to correct a worker that is going the wrong way or to ask what it is doing, instead of cancelling it.

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
| `maxAgents` | Calls per script run, default 32, maximum 2048; cache hits count |
| `maxConcurrent` | Concurrent workers per workflow tree, default 4, maximum 256. Workers take slots from the profile's process pool, so `max_concurrent_runs` (at most 512) must be larger than this for the workflow to reach it |
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

Guest functions:

| API | Behavior |
| --- | --- |
| `agent(prompt, {key, member?, harness?, model?, reasoningEffort?, output?, schema?, onError?, workflowTool?, workspace?, inputs?})` | Promise of final text, a parsed JSON value with `output: "json"` or `schema`, or `null` when the worker fails (see [Failure handling](#failure-handling)). `inputs` lists 1–16 keys of earlier, awaited agent calls in this run; their results reach the worker by reference (ref plus a 2000-character preview) and it reads the full text with `read_artifact` |
| `createWorkspace` / `freezeWorkspace` / `approveChange` / `integrateChanges` / `checkWorkspace` / `acceptIntegration` / `cleanupWorkspace` / `configureLanding` | Opt-in isolated coding, snapshot review and checked private integration; see [worktrees](workflow-worktrees.md) |
| `reviewedAgent(prompt, {key, criteria, worker?, reviewer?, maxRounds?, onError?})` | Independent verification and bounded rework; returns only an accepted result, otherwise `null`; see [collaboration controls](workflow-collaboration.md) |
| `speculativeAgent(prompt, {key, gate, worker?, repair?, maxRounds?, onError?})` | Runs work while an independent gate checks its premise; returns only work built on a premise that passed, otherwise `null`; see [speculation](workflow-collaboration.md#speculate-past-a-long-gate) |
| `discuss(topic, {key, members, maxTurns?, summary?, onError?})` | Multi-agent discussion through the mailbox; members choose recipients each turn; see [multi-agent discussion](#multi-agent-discussion) |
| `swarm(task, {key, lead?, members, maxTurns?, onError?})` | A group of members scheduled by the bridge: woken by board posts that name them and, with `queue`, by claimable work; an optional lead adds and retires members and decides when to finish; see [message board](#message-board-and-swarms) and [queue consumers](#queue-driven-consumers) |
| `post(text, {key, to?})` / `readBoard({key, after?, limit?, member?})` | Post to the workflow's message board as the script, or read the feed; see [message board](#message-board-and-swarms) |
| `send(member, text, {key, topic?, correlationId?})` / `receive(member, {key, topic?, correlationId?, timeoutMs?})` | Send a durable message or await a stable inbox batch |
| `enqueueWork({key, title, input, queue?, priority?, dependsOn?, resources?, maxAttempts?})` | Persist an immutable work item; returns `{itemId, key}` and reuses it on replay |
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

A worker's own failure does not fail the script by default. `agent()` resolves to `null` when the task fails after the executor's retries: execution or policy errors, a native question, invalid JSON, a schema mismatch or a missing final answer. The task remains `failed` in `/workflow status` with its error, and a script log line records which key returned `null`. Pass `onError: "throw"` to reject instead; the error has `name: "WorkflowAgentFailure"`. Invalid calls still reject regardless of `onError`: unknown options, duplicate keys, a member with an unfinished turn, and call, task or deadline budgets.

`parallel` and `pipeline` never reject: a function or stage that throws, including one using `onError: "throw"`, yields `null` in its position and records a log line. Filter results with `.filter(Boolean)` or check for `null` before using them. `reviewedAgent`, `speculativeAgent` and `discuss` also resolve to `null` on failure (including review or gate rejection after `maxRounds`) unless given `onError: "throw"`; option validation errors always throw. `joinTask` and `raceTasks` keep rejecting on a failed task. Failed ordinary calls are not cached, so replay retries them; a failed member turn must still be replayed before that member can take another turn.

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
- Members should address each other through their reply rather than the `send_message` tool. Messages sent through the tool still arrive in the recipient's next turn but do not wake it on their own.

See [the debate example](../workflow-definitions/scripted/examples/debate.js).

### Message board and swarms

Every workflow has one message board: an ordered, append-only feed that all of its agents can read. A post names the members who must act; naming a member delivers the post to its inbox and wakes it. A post that names nobody stays on the board and wakes no one. Posts are never edited or removed.

| Caller | Post | Read |
| --- | --- | --- |
| Persistent member | `post_board` with `{operationId, text, to?}` | `read_board` with `{after?, limit?, member?}` |
| One-off worker | not allowed | `read_board` |
| Main agent | `post_board(text, to?)` | `read_board(after?, limit?, member?)` |
| Script | `post(text, {key, to?})`, as `script` | `readBoard({key, after?, limit?, member?})` |
| User | `/workflow post <text>`, as the main conversation | `/workflow board [count\|member]` |

- `text` is at most 4000 characters. `to` is an array of member names or `"all"`. `@name` and `@all` in the text count as well, so `'Parser done, @qa please verify'` needs no `to`. Unknown names in `to` are rejected; an `@word` that matches no member is ordinary text. The sender is never its own recipient, and `all` means the members that exist when the post is made.
- A read returns `{posts: [{seq, from, to, all?, text, at}], lastSeq, hasMore}`. Without `after` it returns the latest `limit` posts (default 20, at most 50); with `after` it returns the posts following that `seq`. `member` keeps the posts that member wrote or received. `from` is a member name, `main`, `script` or `system`.
- Deliveries are ordinary inbox messages with topic `board` and the fields `post`, `to` and `all?` added, so everything that waits for messages works unchanged: `receive` and the `message` arm of `waitFor`. Swarm members are woken by them directly. As with direct messages, a member sees them in its next turn's member context and they are acknowledged when that turn succeeds.
- A workflow holds at most 8192 posts and 32768 deliveries. Deliveries reference the post instead of copying its text and do not count toward the 4096 direct messages.
- A script read records how far the feed reached under its `key`; replay reads the same range again.

`swarm` declares a group of persistent members that work on the board. The bridge schedules their turns; the script only awaits the outcome:

```js
const outcome = await swarm(args.task, {
  key: 'ship',
  lead: { name: 'lead', role: 'Split the work so pieces do not collide, assign it on the board, judge results. Do no implementation yourself.' },
  members: [
    { name: 'parser', role: 'Own src/parser/**. Hand finished changes to qa.', harness: 'codex', model: args.workerModel },
    { name: 'docs', role: 'Own docs/**.', harness: 'codex', model: args.workerModel },
    { name: 'qa', role: 'Read diffs and run the tests when asked; report problems to the author. Wait until asked.', harness: 'claude' },
  ],
  maxTurns: 6,
});
return outcome.result;
```

1. The task becomes the swarm's first post, then every member takes a first turn in parallel with the task, its role, the roster and the board rules in its prompt.
2. After that each member sleeps without a worker process. A post that names it starts its next turn. Members never wait for each other, so a long implementation turn does not delay a question between two other members.
3. With a `lead`, the swarm ends when the lead calls `swarm_finish`; without one, when every member is asleep and no post is waiting to be read. Members with a `queue` add a condition, described under [queue consumers](#queue-driven-consumers).

The lead is an ordinary member with three more operations and two kinds of system posts:

| Operation | Effect |
| --- | --- |
| `staff_swarm` with `{operationId, add?, like?, queue?, role?, brief?, revive?, retire?, maxTurns?}` | Changes the staff of its swarm while it runs: `add` names new members that use the harness, model, role and queue of the existing member `like` (default: the first member other than the lead) and see `brief` in their first turn; `revive` puts failed members back to work; `retire` lets members finish the turn they are running and never wakes them again; `maxTurns` raises the wake-up limit |
| `swarm_finish` with `{operationId, result}` | Records the final result (at most 16000 characters). Nobody is woken afterwards; the swarm returns once the turns still running have ended |

- When a member fails, the system posts to the lead with the reason; the member has stopped and the lead decides whether to reassign, replace or drop the work.
- When everyone is idle and the lead has not finished, the system reminds the lead, at most twice. After that the swarm ends with `stop: "quiet"` and no `result`.

`swarm` resolves to `{stop, result?, turns, members: [{name, lead?, added?, queue?, turns, status, error?, note}], queues?, posts, lastSeq, hasMore}`. `queues` maps each consumed queue to its item counts. `posts` holds up to the first 50 posts of the swarm; read further ones with `readBoard`. `note` is the start of the member's last final answer: up to 2000 characters, fewer in a swarm of more than 20 members so that the whole result still fits a script value (40000 characters shared by all members).

| `stop` | Meaning |
| --- | --- |
| `finished` | The lead called `swarm_finish`; `result` holds its verdict |
| `quiet` | Everyone went idle without a verdict (or the swarm has no lead) |
| `max_turns` | No lead, and a member that had used its wake-ups still had posts to read |
| `failed` | No lead, and a member failed |

If the lead fails, or the swarm runs out of the workflow's agent-call budget, `swarm` resolves to `null`, or rejects with `onError: "throw"`.

- `members` and `lead` take `{name, role?, harness?, model?, reasoningEffort?, workflowTool?, workspace?, queue?}`: 1–256 at the start, the lead included, and up to 320 once the lead has added some. Names use 1–40 letters, digits, `_`, `.` or `-`, cannot be `all`, `main`, `script` or `system`, and are dedicated to this swarm: `agent`, `receive` and `waitFor` reject them.
- `maxTurns` bounds the wake-ups of each member after its first turn: default 6, range 1–64. Every turn counts toward `maxAgents`; reserve `members × (maxTurns + 1)`.
- The main agent and the user steer a running swarm by posting: `/workflow post @parser also cover CRLF input` wakes `parser`, and `/workflow post @lead drop the docs work` reaches the lead.
- On replay the swarm continues from its record: completed turns are not run again, a turn cut short by a pause or restart is retried in the member's own conversation, and members the lead added stay. The definition (key, task and member bindings) cannot change across replay.
- Put ownership in the roles: who assigns, who owns which files, who verifies and how. A lead that only assigns and judges, and one verifier for every two to four workers, is a reasonable default. Give members that edit the same repository concurrently their own [workspace](workflow-worktrees.md).
- Posts cost turns: every post that names a member wakes it. The member prompt tells members not to post acknowledgements; `maxTurns` is the hard bound.

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

- `read_context` / `task_status`: inspect their own checkpoint, fixed input batch and current checkpoint version.
- `checkpoint` with `{operationId, expectedCheckpointVersion, state}`: save up to 16000 characters of JSON work state. Record progress, decisions, next steps and artifact paths. This does not finish the turn or acknowledge input messages.
- `send_message` with `{operationId, member, text}`: send to another existing member in the same workflow. Sender identity comes from the worker binding.

Worker operation IDs are scoped to the logical turn and deduplicated across attempts. Stale attempt credentials cannot update checkpoints or send messages. The main agent can inspect the latest work state with `read_checkpoint({member})`, and can also use `send_message` with the usual workflow ID, operation ID and state version, including while paused or interrupted; queuing a message does not resume a paused workflow. Members cannot change their execution binding, mutate another member's checkpoint, or create more workers.

Checkpoints, waits, message receipts and turn state are committed together in the bridge's SQLite workflow record. A progress checkpoint survives interruption. Recovery continues from the last saved work state and the backend's persisted native conversation, not a process snapshot. Native transcripts and external file changes are not part of the SQLite transaction. Verify uncertain side effects on retry; delivery and retries do not imply exactly-once external execution. A missing or replaced native session fails visibly rather than silently starting an empty conversation. The bridge records native IDs but relies on the backend's transcript storage and retention.

After a restart, a workflow that was running is replayed automatically (see [Restart recovery](#restart-recovery)); others remain `interrupted` until explicit `replay_script` or `/workflow resume`. Replay reconstructs the script from its beginning, reuses completed turns and receive receipts, then continues pending waits or retries the interrupted turn in its original native session. Persistent turn reuse validates the original request and predecessor chain; the stored input fingerprint includes the checkpoint version and message IDs. Rewriting committed history, skipping its predecessor, or changing a member's execution binding requires a new member name. One-shot tasks without `workflowTool` still retry in fresh sessions; enabled callers retain their native session for child-result continuation.

Limits per workflow: 512 members, 4096 messages, 2048 receive receipts, 8192 worker/script mailbox operations, and 8192 execution attempts including retries. The kernel retains up to 256 recent checkpoints while preserving every member's latest recovery point. Existing workflow call, deadline, replay, output and process-pool limits also apply. Members and the work queue below are scoped to one workflow; they do not create a cross-workflow team.

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
| `work_status` | `itemId?` or `queue?, offset?, limit?`; no `operationId` | Item detail or queue summary |

Each member can hold one active claim. Swarm members declared with a `queue` use that queue and cannot claim from another; other members may specify a queue and default to `default`. Within a queue, higher `priority` (-100 to 100, default 0) is considered first, with FIFO ties. `dependsOn` names up to 32 already-enqueued work keys, including keys in other queues. All prerequisites must complete successfully before a claim is possible; enqueueing prerequisites first prevents cycles. A failed/cancelled prerequisite produces an actionable pool failure; repair it and explicitly replay. Grants are bound to member, logical turn, execution attempt, claim ID and monotonically increasing item generation. The default lease is 120 seconds, with a 1–300 second range capped by the workflow deadline. Save progress before important boundaries and renew early enough for long tools or model calls. Lease expiry cancels the owning turn and requeues the item, unless its attempt budget is exhausted. Turn exit, pause, cancellation, binding invalidation and controller restart also release unfinished claims; saved item progress remains. Restart/pause never starts consumers automatically: explicit replay is still required. `claim_work: null` means end the current consumer turn; the script decides whether another round is needed.

Queue mutation IDs are scoped to the current execution attempt. Repeating the same operation returns its recorded response; different content under that ID conflicts. Retrying a claim does not revive an expired/completed grant, and repeating a `null` claim returns `null`; use a new operation ID for a later claim query. Repeating an already committed completion with its original ID is harmless. Old attempts, owners and generations cannot make a new submission or overwrite a result. This fences bridge state only: external tool/file side effects are not transactional and are not guaranteed exactly once.

`resources` contains explicit exclusion keys shared across all logical queues in this workflow. Items sharing a key cannot hold active claims simultaneously; for example, use one canonical `worktree:<path>` key for all items that edit that worktree. Keys are opaque, matched exactly and local to this workflow. The bridge neither creates worktrees nor enforces filesystem access. A stale external process may still produce side effects after lease loss; verify those effects before resuming uncertain work.

Enqueue keys share the script's key namespace. Replaying the same key/input reuses its existing item and does not reset its result or progress; changing immutable input under that key fails. `maxAttempts` defaults to 3. Every new grant consumes an attempt, including voluntarily released and expired grants. Main can use `enqueue_work` or `retry_work({itemId, additionalAttempts?})` with the usual workflow ID, operation ID and state version. Retry applies only to failed items, adds a default allowance of one (1–8 per request, at most 32 cumulative generations), and never resets the generation. Resolve the failure and explicitly replay as needed. Retry does not cause previously successful, cached consumer turns to run again: add a new round/member when all original consumer calls were already successful. Pending or claimed work prevents script success and main completion. Failed items remain visible for main review; the packaged example treats them as an error.

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

- A queue member takes no opening turn: it starts with its first claimable item. Until then it does not exist as a member, so a post cannot name it yet.
- Its prompt tells it to use `claim_work`, `checkpoint_work` and `complete_work`, and to end the turn when a claim returns `null`. It must not sleep or poll. One turn usually claims several items in a row.
- The scheduler bounds dispatch by the claimable items and the turns that have not claimed yet. A member that raced another may still receive no item; the same set of available work does not wake it twice.
- A queue member is still woken by posts that name it, and handles them before consuming work. One swarm can mix queue members with members that only answer posts, and members can consume different queues; see [routed work](workflow-scheduling.md#routed-work-and-dependencies).
- A member whose turn fails, or whose claim lease expires, stops for this script run. Its claim is released and the other members take the work over. Explicit replay retries its unfinished turn.
- `maxTurns` bounds each member's wake-ups (default 6, up to 64); raise it when work arrives in batches. Every turn counts toward `maxAgents`.

**Closure of each queue is explicit and permanent.** An open but empty queue waits for new input; a closed queue stops accepting items and drains the existing ones. A swarm without a lead ends only when every queue its members consume is closed and holds no unfinished item, and nobody has a post to read. It fails if it goes idle while work is still available that no member can take, or with failed or unclaimable items. A swarm with a lead ends on the lead's `swarm_finish` as usual; the lead is reminded when everyone is idle.

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

Enqueue accepts optional `resources` and `maxAttempts`. These commands never create a workflow; when paused/interrupted they only persist the change. Restart cancels orphaned claims; scheduling resumes with the automatic or explicit replay. `/workflow work` and `/workflow status [member]` display queue closure, pool state, turn budget, idle waits and stopped members, including before a member's first native turn. Ordinary messages do not enter workflow mode.

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

- `configureLanding({key, checks, target?, strict?})` names the private branch `bridge-workflow/<workflowId>/<target>` (default `result`) and the 1–4 commands every landing must pass. Calling it again replaces the configuration.
- A member with a worktree calls `submit_work({operationId, claimId?, generation?, result?})` after committing. The bridge rebases its commits onto the branch head, runs the checks in that worktree and advances the branch if it has not moved. With a claim, the work item is completed with `result` (by default the landed commit) in the same call.
- `conflict` and `check_failed` are answers, not failures: the member keeps its claim, repairs the worktree and submits again with a new `operationId`. After a conflict the worktree is exactly as submitted; after failed checks it is left rebased. The claim's lease is renewed while checks run.
- Checks of different members run side by side; only advancing the branch is serialized. With `strict` (default) the commit that lands is the one that passed the checks, so a member whose base moved during its checks rebases and checks again, and after losing twice takes the queue for its next round. With `strict: false`, passing once and rebasing cleanly is enough: faster when checks are slow and changes rarely interact, but the combination is unchecked, so have the script run `checkWorkspace` on the branch now and then.
- A call blocks until the checks finish. If the member's shell cuts it off, repeating it with the same `operationId` joins the landing in progress.
- Nothing is pushed and the original checkout is not touched. Limits: 384 worktrees per workflow.

The [packaged example](../workflow-definitions/scripted/examples/claim-and-land.js) takes `items`, `checks`, and optional `members`, `strict`, `prompt` and `model`.

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

The tree shares root worker concurrency, task-history budget and deadline, and at most 8192 native attempts. Child limits can reduce these allowances. There are at most three child levels and 256 child workflows per root. The parent continuation counts as another attempt of its original task. Completed child results and plans remain inspectable artifacts; only the root's plan and final event are sent to the chat.

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

Optional `designerModel` and `reviewerModel` select models supported by those harnesses. Keep the member bindings and `reviewId` stable on replay. By default the discussion runs to completion. Set `waitForStart: true` to wait at B's inbox after both members are created; a main-agent `send_message` to member `B` starts the review. If the workflow has been interrupted, explicitly replay it after queuing the message. A's inbox wait then receives the review, and its successful revision consumes that receipt.

The opt-in acceptance runner uses real Codex, Claude and Pi CLIs in the current authorized bridge profile. It calls model services and can incur usage costs. From a source checkout with dependencies installed and `dist/cli.js` built:

```sh
npm run build
npm run test:workflow-native -- --output /absolute/path/outside-the-repository/native-acceptance
```

Use `--backends codex` to limit the backends, and `--scenarios memory,interrupt,discussion,queue` to select cases. The default scenarios are memory, interrupt and discussion; opt into `--scenarios queue` for the three-consumer queue test or `--scenarios consumers` for queue-driven wakeups, or `--scenarios nested` for nested tool execution with one process slot. The discussion uses the first selected backend for A and the second for B, or the first for both if only one is selected. The runner uses native configured defaults without injecting a model service override, copying credentials, or switching profiles. The observed model is recorded when the backend reports it. Missing native authentication is a failed acceptance prerequisite, not a passing test.

Additional nested lifecycle cases run with `--scenarios nested-recovery,nested-cancel,nested-queue,nested-before-yield`. All use one native worker slot in an isolated controller/database:

- `nested-recovery`: parent, middle caller and persistent leaf are three native sessions. Pause after the leaf checkpoint, exit the controller, explicitly replay in a fresh process, and require all three original sessions and the checkpoint/result to survive.
- `nested-cancel`: cancel while the leaf is running. Require all three workflows and tasks to stop, zero process slots, rejection of a late checkpoint, and no further dispatch or main-chat wakeup.
- `nested-queue`: a child planner produces four values and enqueues work into its parent's queue. A persistent consumer completes each item once; explicit closure lets the swarm drain and return.
- `nested-before-yield`: close the controller directly after a parent commits its child, before it yields. Explicit replay must execute that same child and return its result to the original parent session. A controller shutdown must not convert the accepted child into a permanent cancellation.

These recovery cases use controlled controller shutdown. Opt into `--scenarios nested-crash` on POSIX to SIGKILL the isolated controller immediately after the native parent yields, before its pending child runs. The launcher requires the expected crash signal and saved boundary evidence, then explicitly replays in a fresh process and verifies the original parent session and child result. This case waits for the native turn to exit before killing the controller; it does not kill the shared Codex daemon or test recovery of an active native turn.

`tests/process/workflow-crash-recovery.test.ts` also exercises six deterministic SIGKILL boundaries with real SQLite storage and controlled workers: child-call commit before yield, child-result commit before consumption, uncommitted child insertion, uncommitted child completion, claimed work with saved progress, and completed work. It checks transaction rollback, database integrity, explicit replay, deduplication, progress retention and rejection of stale attempts/claim generations. These are controller-process crashes, not machine power loss; external tool side effects still require idempotency checks.

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

For scripts, `/workflow pause` aborts the interpreter and cancels queued/running workers. Wait for worker cancellation to finish before `/workflow resume`; resume replays with cached completed calls. `/workflow cancel` and `/stop` cancel the whole workflow. Root session, engine, workspace or policy changes prevent reuse and further dispatch; main model or reasoning-effort changes do not. Target configuration changes invalidate matching worker cache entries. After restart, unfinished scripts are marked `interrupted`. Running roots resume automatically; the others accept `replay_script` or `/workflow resume` while the original root binding and deadline remain valid. At the deadline the running script fails with `Workflow deadline reached` and its workers are cancelled; it cannot be resumed or replayed. The main agent may still publish a report and `complete` with partial results, or the user cancels it; either releases the topic for a new workflow.

### Restart recovery

Bridge restarts are safe for running workflows. On startup the bridge:

1. **Marks** every unfinished workflow `interrupted`. It records when the outage began, using a heartbeat the kernel writes every 5 seconds.
2. **Replays automatically** each root workflow whose script was queued or running, but only when two conditions still hold:
   - the original root binding (main session, engine, workspace and permissions) is unchanged;
   - the deadline was not already reached before the restart.

   Completed calls are reused. A worker that was still running when the bridge stopped keeps running under its run host (Linux and macOS, see [runtime reference](runtime-reference.md)); when the replayed script reaches the same call (same key, prompt, inputs and binding for one-shot calls, the same logical turn for members), the bridge attaches to that process and the turn continues without restarting. Its workflow tool token stays valid, and the worker CLI finds the new controller through `workflows.sqlite.endpoint.json`, so calls a worker makes during the outage fail and calls after it succeed. Turns whose run host is gone retry; persistent members retry in their original native session. Turns in managed worktrees and turns that held a work claim are not kept: the claim is released at restart, so their process is ended and the turn retries. Surviving workers of a workflow that does not resume, or whose call the replay no longer reaches, are ended.
3. **Pauses the clock.** Time spent interrupted, including the outage itself, does not count toward the deadline. The deadline is extended once, when the workflow is replayed, whether automatically or explicitly.
4. **Reports** each outcome in the workflow's chat or topic: either that the workflow resumed, or why it did not.

A workflow that does not resume automatically stays `interrupted`, and `/workflow resume` replays it. The bridge does not retry it again on later restarts. This includes workflows that were paused, waiting for a binding decision, or had already finished their script before the restart.

**Why the chat is known after a restart.** The bridge persists the latest message per chat or topic in `workflow-origins.json`, next to `workflows.sqlite`. It uses this record to authorize the root session and to address replies.

**Upgrading from an earlier version.** Earlier versions kept this record only in memory and wrote no heartbeat. Their workflows therefore cannot resume automatically on the first restart into this version, until a new message arrives in that chat. Pause or let them finish before upgrading.

Replay repeats interrupted work: side effects in the outside world (files, network) may be repeated, exactly as with an explicit replay.

### Interpreter and execution boundaries

QuickJS/WASM runs the script with JSON-only host callbacks, no host objects, process, filesystem, network or module loader. `Date` and `Math.random` are disabled; pass such inputs through `args`. Each interpreter has a 256 MiB guest heap, 512 KiB stack, 100 ms synchronous slices, approximately 2 seconds of guest CPU and 100,000 promise jobs. There are at most four active interpreters per nesting depth, with four levels including roots (at most sixteen total). Waiting ancestors cannot exhaust the interpreter capacity needed by their children. Source, arguments, worker output and final output have bounded sizes (100,000 characters); status retains at most 50 log entries of 1,000 characters. A deadline/abort signal also terminates scripts awaiting an unresolved promise.

The interpreter boundary does **not** isolate workers: a worker is a normal configured harness under the original authorized profile, workspace and effective permissions. Scripts cannot select another profile or provide environment variables or credentials. Workers may perform only tasks authorized by the goal, and their final answers do not establish that tests or side effects succeeded. The main agent reviews evidence and reports validation limits.
