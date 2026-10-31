# Workflows

Workflows are script-driven. The bridge owns scheduling, task state, worker sessions and final result notifications; the main agent writes and reviews the script. Both the main agent and each worker can select a harness **and** a model. Configured Codex, Claude and Pi backends can be mixed in one workflow, and multiple workers can use different models under the same harness.

## Invoke from Lark

First set the main agent in the target chat/topic:

1. Send `/config run` and choose its execution engine (Codex, Claude or Pi).
2. Send `/model <model ID>` and optionally `/effort <level>` for the main model and reasoning effort. `/model` without arguments opens the selection card. A configured service can be selected with `<provider>/<model>`.
3. Start the workflow, giving the task and worker selections in natural language:

```text
/workflow start 架构评审：Pi 使用 <方案模型> 提出方案，Claude 使用 <替代模型> 提出独立方案，Codex 使用 <审查模型> 审查并汇总。需求：……
```

Replace bracketed placeholders with models supported by the configured harness/provider. In groups, genuinely mention the bot when required by the chat settings. The bot writes a concrete execution plan and script, publishes the plan before starting workers, then returns the reviewed result to the same chat/topic. You do not need to write JavaScript in Lark.

Workflows start only through `/workflow start` or `/workflow script`. The bridge command handler marks the queued request, and only that route receives permission to create a workflow. Ordinary message turns use the main agent directly and receive neither workflow instructions nor workflow credentials, even when a workflow exists in the topic. Natural-language mentions, quotations and task types do not switch modes. Internal completion events receive a continuation binding restricted to the existing workflow; they cannot create a new one. The API checks the caller's bridge-issued start permission independently of prompt text or request parameters.

The bridge selects a typed agent entry before preparing a turn: `direct` for ordinary messages, or `workflow` with a command/event trigger. The queue preserves this entry across restart and keeps command turns separate from ordinary message batches. Entry handlers prepare their own instructions, credentials and lifecycle callbacks, then share the existing session, agent-execution and output layers. Additional entry types can extend this boundary; only direct and workflow entries are implemented today.

Use `/workflow help` for the built-in command reference and a startup example; it is available before starting a workflow and does not launch an agent. `/workflow script <task>` remains an alias for the same script entry. It is not a separate engine. Use `/workflow plan` to see the saved execution plan (stages, assignments, selected models, dependencies and conditional branches), and `/workflow status [member]` to inspect execution and recovery progress. Both commands show the most recent workflow after completion/cancellation. Use `/workflow pause` and `/workflow resume` to pause/replay, and `/workflow cancel` or `/stop` to cancel. Choose main settings before starting: changing the root session, engine or model invalidates the existing binding.

Status shows each member's current turn and attempt count, actual execution state, receive batch, latest checkpoint version/time, and a bounded diagnostic reason when execution fails. `status A` also shows member A's task objective, unacknowledged message count and six most recent turns. Waiting for a message, reserving it for a turn, and acknowledging it after successful completion are shown separately. Checkpoint state and message bodies are not included in these summaries. General status prioritizes members/tasks that need attention and limits expanded entries; long text is shortened and credential patterns in errors are redacted. Status is read-only: inspecting a paused/interrupted workflow or queuing messages does not replay it. Follow the displayed recovery hint after resolving the cause.

The old `architecture-review` plugin and agent-led `start`, `delegate`, `send`, `begin_revision_round` API operations have been removed. When explicitly requested, a workflow can perform architecture review as an ordinary script use case; there is no fixed designer/challenger plugin. On upgrade, unfinished old instances are cancelled and release their topic binding. Their existing artifacts remain readable by workflow ID, but old instances cannot resume. The packaged review example demonstrates independent proposals and a conditional revision through this common API.

## Harness and model selection

| Selection | Configuration | Scope |
| --- | --- | --- |
| Main agent | `/config run`, `/model`, `/effort` | Current chat/topic, captured at workflow creation |
| Worker defaults | `run_script.execution: {agentKind, model?, reasoningEffort?}` | Calls without an explicit override |
| Individual worker | `agent(..., {harness, model, reasoningEffort, key})` | This call only; each call can select another model |

Worker defaults do not change the main agent. With no override, workers inherit settings for the selected harness. Switching harness does not carry a different harness's model name. Explicit model selection is recommended for reproducible runs; an omitted native default is not a frozen model version. The model is part of the cache fingerprint, so changing one worker's model reruns that task and any downstream calls whose inputs change.

Only the original authorized profile, workspace and effective permissions are used. Arbitrary profile names, environment variables or credentials cannot be supplied by a script. The target must provide authoritative `final_text` and support the requested model/access mode. Native IDs are recorded from backend system events and stay outside the root session catalog. Progress, partial output and non-normal completion cannot become worker results.

## Script API

A script is a JavaScript **function body** with top-level `await` and `return`. Control flow is ordinary JavaScript: a worker's result can select a branch, create more calls, or feed subsequent stages. No static graph needs to be declared. See [the cross-harness review example](../workflow-definitions/scripted/examples/review.js).

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
node "$LARK_WORKFLOW_CLI" workflow run_script --input-file workflow.json --json
```

The envelope has `operationId`, `goal` (the full authorized task), `script` (the function body as a string) and `plan` (a human-readable execution plan, up to 12,000 characters). The plan must describe phases, each worker's harness/model/task, dependencies and conditional branches. Lark publishes it before any worker starts; delivery failure stops execution. This is visibility, not a new approval gate. The plan is stored as a versioned `workflow-plan` artifact (`planRef`); the exact script remains available through `sourceRef` and `read_artifact`. A plan describes intended behavior; `/workflow status` shows the actual branches and tasks reached. Optional fields:

| Field | Meaning |
| --- | --- |
| `name` | Display name, up to 100 characters |
| `args` | JSON data exposed as `args` in the interpreter |
| `execution` | Default `{agentKind, model?, reasoningEffort?}`; otherwise root harness/settings |
| `maxAgents` | Calls per script run, default 32, maximum 128; cache hits count |
| `maxConcurrent` | Concurrent workers per workflow, default 4, maximum 16; shared process-pool limits also apply |
| `timeoutMs` | Total workflow deadline, default 30 minutes, range 1 second to 120 minutes; replay does not extend it |

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
| `agent(prompt, {key, member?, harness?, model?, reasoningEffort?, output?, workflowTool?})` | Promise of final text, or a parsed JSON value with `output: "json"` |
| `send(member, text, {key})` / `receive(member, {key})` | Send a durable message or await a stable inbox batch |
| `enqueueWork({key, title, input, resources?, maxAttempts?})` | Persist an immutable work item; returns `{itemId, key}` and reuses it on replay |
| `workStatus({itemId?, offset?, limit?})` | Read one item with its payload, or bounded queue counts and summaries |
| `consumeWork({key, members, prompt, maxTurns?})` | Schedule dedicated persistent consumers and wait until the closed queue drains |
| `closeWorkQueue({key})` | Persist queue closure; existing items continue, new items are rejected |
| `parallel([() => ..., () => ...])` | Starts functions and returns results in input order |
| `pipeline(items, ...stages)` | Processes items concurrently; each item passes through its stages sequentially as `stage(value, index)` |
| `phase(text)` / `log(text)` | Bounded progress recorded in status; does not wake main |

`key` is required, stable across replay, and unique within one run. A selected harness uses its configured defaults unless model/effort overrides are supplied. Switching harness does not inherit a different harness's model. All calls must be awaited; the interpreter rejects a result while agent calls are still pending. Failures reject promises, including invalid JSON, missing final answers, native questions and unsupported harnesses. `parallel` and `pipeline` reject on failure; use explicit `try/catch` to implement a fallback. JSON parsing does not validate a schema: check required fields in the script.

Only script completion/failure creates a main-agent event, rather than an event for every worker. Final return values are serialized into a `workflow-result` artifact; no return means JSON `null`. The main agent reads the artifact, acknowledges events, and calls `complete` with that artifact reference, `openIssues` and `verificationLimits`. Persistent members can checkpoint their own work and send internal mailbox messages. Workers cannot send parent answers, manage other members, or recursively delegate through the workflow API. Worker scheduling belongs to the script. Named members continue their native sessions; ordinary agent calls remain independent. A main-authored `report` artifact can also be used for completion.

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

`send(member, text, {key})` queues up to 4000 characters for an existing member and returns `{messageId}`. `receive(member, {key})` resolves with up to 16 `{id, from, text}` messages, or waits if none are available. Both are JSON-only sandbox calls and must be awaited. Agent and mailbox keys share one per-run namespace. Script sends are deduplicated across replay; reusing a send key with different content fails.

A receive reserves a stable batch. It does not acknowledge the messages. The next turn for that member receives the batch in its context; successful turn completion atomically saves a checkpoint and acknowledges those messages. Failed or cancelled attempts leave them available to that same logical turn. Messages arriving before a wait are delivered immediately; arrivals after a wait wake it. A member can have only one outstanding receive. Follow it with the next member turn to acknowledge the batch. The script controls which event starts each turn; there is no autonomous member loop.

Members can use their scoped CLI to call:

- `read_context` / `task_status`: inspect their own checkpoint, fixed input batch and current checkpoint version.
- `checkpoint` with `{operationId, expectedCheckpointVersion, state}`: save up to 16000 characters of JSON work state. Record progress, decisions, next steps and artifact paths. This does not finish the turn or acknowledge input messages.
- `send_message` with `{operationId, member, text}`: send to another existing member in the same workflow. Sender identity comes from the worker binding.

Worker operation IDs are scoped to the logical turn and deduplicated across attempts. Stale attempt credentials cannot update checkpoints or send messages. The main agent can inspect the latest work state with `read_checkpoint({member})`, and can also use `send_message` with the usual workflow ID, operation ID and state version, including while paused or interrupted; queuing a message does not resume a paused workflow. Members cannot change their execution binding, mutate another member's checkpoint, or create more workers.

Checkpoints, waits, message receipts and turn state are committed together in the bridge's SQLite workflow record. A progress checkpoint survives interruption. Recovery continues from the last saved work state and the backend's persisted native conversation, not a process snapshot. Native transcripts and external file changes are not part of the SQLite transaction. Verify uncertain side effects on retry; delivery and retries do not imply exactly-once external execution. A missing or replaced native session fails visibly rather than silently starting an empty conversation. The bridge records native IDs but relies on the backend's transcript storage and retention.

After a restart, the workflow remains `interrupted` until explicit `replay_script`. Replay reconstructs the script from its beginning, reuses completed turns and receive receipts, then continues pending waits or retries the interrupted turn in its original native session. Persistent turn reuse validates the original request and predecessor chain; the stored input fingerprint includes the checkpoint version and message IDs. Rewriting committed history, skipping its predecessor, or changing a member's execution binding requires a new member name. One-shot tasks without `workflowTool` still retry in fresh sessions; enabled callers retain their native session for child-result continuation.

Limits per workflow: 32 members, 256 messages, 128 receive receipts, 512 worker/script mailbox operations, and 128 execution attempts including retries. The kernel retains up to 256 recent checkpoints while preserving every member's latest recovery point. Existing workflow call, deadline, replay, output and process-pool limits also apply. Members and the work queue below are scoped to one workflow; they do not create a cross-workflow team.

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
| `claim_work` | `leaseMs?` | `{claimId, generation, leaseUntil, item}`, or `null` if nothing is currently claimable |
| `renew_claim` | `claimId, generation, leaseMs?` | Updated lease, never shorter than the existing lease |
| `checkpoint_work` | `claimId, generation, expectedProgressVersion, state` | Persisted item progress version |
| `complete_work` | `claimId, generation, result` | Terminal completed status |
| `fail_work` | `claimId, generation, error, retry?` | Failed status, or pending when `retry: true` and attempts remain |
| `release_claim` | `claimId, generation, reason` | Pending status, or failed when attempts are exhausted |
| `work_status` | `itemId?` or `offset?, limit?`; no `operationId` | Item detail or queue summary |

Each member can hold one active claim. Grants are bound to member, logical turn, execution attempt, claim ID and monotonically increasing item generation. The default lease is 120 seconds, with a 1–300 second range capped by the workflow deadline. Save progress before important boundaries and renew early enough for long tools or model calls. Lease expiry cancels the owning turn and requeues the item, unless its attempt budget is exhausted. Turn exit, pause, cancellation, binding invalidation and controller restart also release unfinished claims; saved item progress remains. Restart/pause never starts consumers automatically: explicit replay is still required. `claim_work: null` means end the current consumer turn; the script decides whether another round is needed.

Queue mutation IDs are scoped to the current execution attempt. Repeating the same operation returns its recorded response; different content under that ID conflicts. Retrying a claim does not revive an expired/completed grant, and repeating a `null` claim returns `null`; use a new operation ID for a later claim query. Repeating an already committed completion with its original ID is harmless. Old attempts, owners and generations cannot make a new submission or overwrite a result. This fences bridge state only: external tool/file side effects are not transactional and are not guaranteed exactly once.

`resources` contains explicit exclusion keys. Items sharing a key cannot hold active claims simultaneously; for example, use one canonical `worktree:<path>` key for all items that edit that worktree. Keys are opaque, matched exactly and local to this workflow. The bridge neither creates worktrees nor enforces filesystem access. A stale external process may still produce side effects after lease loss; verify those effects before resuming uncertain work.

Enqueue keys share the script's key namespace. Replaying the same key/input reuses its existing item and does not reset its result or progress; changing immutable input under that key fails. `maxAttempts` defaults to 3. Every new grant consumes an attempt, including voluntarily released and expired grants. Main can use `enqueue_work` or `retry_work({itemId, additionalAttempts?})` with the usual workflow ID, operation ID and state version. Retry applies only to failed items, adds a default allowance of one (1–8 per request, at most 32 cumulative generations), and never resets the generation. Resolve the failure and explicitly replay as needed. Retry does not cause previously successful, cached consumer turns to run again: add a new round/member when all original consumer calls were already successful. Pending or claimed work prevents script success and main completion. Failed items remain visible for main review; the packaged example treats them as an error.

Use `/workflow work` for counts and ownership, or `/workflow work <key>` for resource keys, saved progress version/time and recent claim history. `/workflow status [member]` also shows queue progress and member ownership. Summary output omits input/progress/result payloads; authorized `work_status({itemId})` returns the full item. Queries are read-only and do not renew leases or restart execution.

Limits per workflow: 256 items, 512 claim records, 2048 queue mutation records, 16 resource keys per item, and 2 MB serialized queue state. Each input, progress state and result is limited to 16000 JSON characters. Status defaults to 16 items per page (maximum 64); use `nextOffset` for the next page. A script run can make at most 128 queue calls, including status queries, independently of its agent-call budget. The queue is bounded and intended for work within one workflow, not an unbounded service queue.

### Queue-driven consumers

`consumeWork` owns the consumer lifecycle within an explicitly started script workflow. The bridge schedules turns when work becomes claimable, resumes the same native sessions for subsequent turns, and records an idle wait when no work is available. Waiting consumes no worker process or process-pool slot. The bounded script interpreter remains active and the workflow deadline continues to run; this is not an indefinite background service.

```js
for (const item of args.items) await enqueueWork(item);
await closeWorkQueue({key: 'production-finished'});
return await consumeWork({
  key: 'consumers',
  members: [{name: 'A', harness: 'codex'}, {name: 'B', harness: 'codex'}],
  prompt: 'Handle the authorized work, preserve progress and verify the result.',
  maxTurns: 32,
});
```

A workflow has at most one pool with 1–16 dedicated member names. Each member supports `harness`, `model`, `reasoningEffort` and `workflowTool` (default false); omitted settings follow the script defaults. The pool key, prompt, membership, turn budget and resolved execution bindings are immutable across replay. Pool members cannot also be scheduled with `agent()` or wait on script `receive()`. They are created lazily when work arrives. Generated turn keys use the reserved `@consumer/` prefix; ordinary script keys cannot use it.

Members keep using `claim_work`, `checkpoint_work`, `renew_claim` and `complete_work`. When a claim returns `null`, they finish their turn immediately. They must not sleep or poll waiting for more items. The scheduler considers available resource keys and outstanding turns to bound dispatch. A worker racing another consumer may still receive no item; its native process then exits. The scheduler does not repeatedly invoke a no-progress consumer for the same available work. If no consumer can make progress, it fails with an actionable reason instead of spinning. Workers' successful final answers automatically save member checkpoints; item checkpoints remain explicit.

A failed or interrupted member stops participating for the current script run. Its claim is released and other members can continue. Explicit replay can retry that member's original unfinished turn when work is available. Completed turns are reconstructed as cache hits without rerunning their side effects; subsequent turns preserve their predecessor chain and native session. Failed work items reject the pool after active turns finish. Inspect `/workflow work`, use `retry_work` for recoverable items, then explicitly replay. Native authentication/session failures remain visible; there is no silent replacement with another profile or a fresh conversation.

`maxTurns` bounds the pool's total logical turns, defaulting to the smaller of 32 and the script's `maxAgents` and capped at 128. Every scheduled consumer turn counts against `maxAgents`; restored completed turns count as cache hits. Workflow history/attempt limits, worker concurrency, shared foreground-priority process slots and the original deadline also apply. Exhausted budgets fail visibly; replay does not reset them or extend the deadline.

**Queue closure is explicit and permanent.** An open but empty queue waits for new input. A closed queue stops accepting new items and drains existing ones. `consumeWork` returns `{queue, consumers}` only after there are no pending/claimed items and all its active turns have exited. It rejects on terminal item failures or exhausted/no-progress consumers. Replaying enqueue calls still reuses identical existing items after closure. Explicit retry of an existing failed item is allowed after closure, followed by replay; reopening for new items requires a new workflow. Closing does not cancel running workers.

For concurrent producers, await both producer and consumer branches:

```js
return await parallel([
  () => consumeWork({key: 'pool', members: args.members, prompt: args.consumerPrompt}),
  async () => {
    const items = await agent(args.planningTask, {key: 'producer', output: 'json'});
    for (const item of items) await enqueueWork(item);
    return await closeWorkQueue({key: 'production-finished'});
  },
]);
```

The [packaged consumer example](../workflow-definitions/scripted/examples/consumer-pool.js) accepts `items`, `members`, `consumerPrompt`, optional `maxTurns`, and `keepOpen`. By default it closes the queue after enqueueing the initial batch. With `keepOpen: true`, main must close it after additional authorized work arrives. Main CLI operations use the normal workflow ID, operation ID and expected state version. Chat controls for an existing workflow are:

```text
/workflow enqueue {"key":"extra-item","title":"Additional task","input":"Task details within the original goal"}
/workflow close
```

Enqueue accepts optional `resources` and `maxAttempts`. These commands never create a workflow; when paused/interrupted they only persist the change. Restart marks the pool suspended, cancels orphaned claims and requires explicit replay before scheduling. `/workflow work` and `/workflow status [member]` display queue closure, pool state, turn budget, idle waits and stopped members, including before a member's first native turn. Ordinary messages do not enter workflow mode.

### Nested workflows as a worker tool

Set `workflowTool: true` on each caller that may delegate. Omitted or false means no tool instructions and server-side rejection of `run_workflow`. Each child script makes this choice independently for its own workers; the flag is never inherited automatically. `consumeWork` accepts the same flag per member. Direct-mode agents receive neither workflow instructions nor a workflow binding, and cannot enable the capability themselves.

```js
return await agent(args.task, {
  key: 'designer', member: 'designer', workflowTool: true,
});
```

The enabled worker can run the following CLI with a JSON file:

```sh
node "$LARK_WORKFLOW_CLI" workflow run_workflow --input-file child.json --json
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

Children have their own members, mailboxes and work queues. Explicit `parentQueue: true` grants only `enqueueWork({queue:"parent", key, title, input, ...})` into the immediate parent's queue. It does not grant consumption, closure, arbitrary workflow access or root control. The parent must keep its queue open until its producers finish. Keys in that queue are shared by all its producers; coordinate them to avoid conflicting inputs. See [the nested example](../workflow-definitions/scripted/examples/nested-workflow.js) for independent per-worker flags.

The tree shares root worker concurrency, task-history budget and deadline, and at most 128 native attempts. Child limits can reduce these allowances. There are at most three child levels and 32 child workflows per root. The parent continuation counts as another attempt of its original task. Completed child results and plans remain inspectable artifacts; only the root's plan and final event are sent to the chat.

Pause, cancellation, binding changes and deadlines apply to descendants. After a restart, explicit root replay reconstructs the waiting parents and paused/interrupted child scripts; it does not rerun completed child calls. Recovery retains native sessions, pending child IDs and checkpoints. Root completion requires descendants to be finished. Local state recovery does not guarantee exactly-once external side effects.

### Discussion example and native acceptance

[The A → B → A example](../workflow-definitions/scripted/examples/discussion.js) creates two persistent members. A proposes a design, B reviews it, and A revises its original proposal using B's mailbox message. It returns all three documents and validates the response fields. Supply these script arguments:

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
- `nested-queue`: a child planner produces four values and enqueues work into its parent's queue. A persistent consumer completes each item once; explicit closure drains the pool.
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

`replay_script` requires the usual `workflowId`, unique `operationId` and current `expectedStateVersion`. It optionally replaces `script`, `args` or `execution`; changes to any of these require an updated `plan`. Each replay publishes its plan again and restarts the function from its beginning. Completed calls are reused by a fingerprint of **key, prompt, output mode, resolved worker binding, root binding, goal and workflow definition**. Changing execution order alone does not invalidate unrelated calls. For independent calls, changing a prompt or harness reruns that call in a fresh worker session; downstream calls rerun when the data in their prompts changes. Failed, cancelled, interrupted or waiting-for-input results are never cached. A named member retries the same logical turn in its original session; an independent task without `workflowTool` retries in a fresh session. Workflow-enabled tasks retain their native session and child-call history. The tool flag participates in the task fingerprint; it can be set independently on each new member turn. Up to eight replays and 128 total task attempts are retained per workflow.

This is result reuse, not replay of external side effects. File contents, network state, time and other implicit dependencies are not automatically hashed. Include relevant revisions or digests in prompts/keys when fresh execution is required. A task interrupted after a side effect may repeat that effect on replay. Worker tasks that modify shared files need an explicit ownership or serialization strategy. Queue resource keys can serialize claims when supplied; the workflow does not create worktrees or infer which files a task will modify.

For scripts, `/workflow pause` aborts the interpreter and cancels queued/running workers. Wait for worker cancellation to finish before `/workflow resume`; resume replays with cached completed calls. `/workflow cancel` and `/stop` cancel the whole workflow. Root session, workspace, policy or model changes prevent reuse and further dispatch. Target configuration changes invalidate matching worker cache entries. After restart, unfinished scripts are marked `interrupted`; explicit `replay_script` is supported while the original root binding and deadline remain valid. There is no automatic recovery. An expired workflow must be cancelled and a new one started.

### Interpreter and execution boundaries

QuickJS/WASM runs the script with JSON-only host callbacks, no host objects, process, filesystem, network or module loader. `Date` and `Math.random` are disabled; pass such inputs through `args`. Each interpreter has a 32 MiB guest heap, 512 KiB stack, 100 ms synchronous slices, approximately 2 seconds of guest CPU and 100,000 promise jobs. There are at most four active interpreters per nesting depth, with four levels including roots (at most sixteen total). Waiting ancestors cannot exhaust the interpreter capacity needed by their children. Source, arguments, worker output and final output have bounded sizes (100,000 characters); status retains at most 50 log entries of 1,000 characters. A deadline/abort signal also terminates scripts awaiting an unresolved promise.

The interpreter boundary does **not** isolate workers: a worker is a normal configured harness under the original authorized profile, workspace and effective permissions. Scripts cannot select another profile or provide environment variables or credentials. Workers may perform only tasks authorized by the goal, and their final answers do not establish that tests or side effects succeeded. The main agent reviews evidence and reports validation limits.
