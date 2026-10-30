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

Use `/workflow help` for the built-in command reference and a startup example; it is available before starting a workflow and does not launch an agent. `/workflow script <task>` remains an alias for the same script entry. It is not a separate engine. Use `/workflow plan` to see the saved execution plan (stages, assignments, selected models, dependencies and conditional branches; after completion/cancellation it shows the most recent workflow), and `/workflow status` to see the main and worker harnesses/models, task state and phase, `/workflow pause` and `/workflow resume` to pause/replay, and `/workflow cancel` or `/stop` to cancel. Choose main settings before starting: changing the root session, engine or model invalidates the existing binding.

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
| `agent(prompt, {key, harness?, model?, reasoningEffort?, output?})` | Promise of final text, or a parsed JSON value with `output: "json"` |
| `parallel([() => ..., () => ...])` | Starts functions and returns results in input order |
| `pipeline(items, ...stages)` | Processes items concurrently; each item passes through its stages sequentially as `stage(value, index)` |
| `phase(text)` / `log(text)` | Bounded progress recorded in status; does not wake main |

`key` is required, stable across replay, and unique within one run. A selected harness uses its configured defaults unless model/effort overrides are supplied. Switching harness does not inherit a different harness's model. All calls must be awaited; the interpreter rejects a result while agent calls are still pending. Failures reject promises, including invalid JSON, missing final answers, native questions and unsupported harnesses. `parallel` and `pipeline` reject on failure; use explicit `try/catch` to implement a fallback. JSON parsing does not validate a schema: check required fields in the script.

Only script completion/failure creates a main-agent event, rather than an event for every worker. Final return values are serialized into a `workflow-result` artifact; no return means JSON `null`. The main agent reads the artifact, acknowledges events, and calls `complete` with that artifact reference, `openIssues` and `verificationLimits`. Workers cannot mutate workflow state, send parent answers, or recursively delegate through the workflow API. Worker scheduling belongs to the script; there is no manual delegation or native-session continuation API. A main-authored `report` artifact can also be used for completion.

### Replay and lifecycle

`replay_script` requires the usual `workflowId`, unique `operationId` and current `expectedStateVersion`. It optionally replaces `script`, `args` or `execution`; changes to any of these require an updated `plan`. Each replay publishes its plan again and restarts the function from its beginning. Completed calls are reused by a fingerprint of **key, prompt, output mode, resolved worker binding, root binding, goal and workflow definition**. Changing execution order alone does not invalidate unrelated calls. Changing a prompt or harness reruns that call in a fresh worker session; downstream calls rerun when the data in their prompts changes. Failed, cancelled, interrupted or waiting-for-input tasks are never reused. Up to eight replays and 128 total task attempts are retained per workflow.

This is result reuse, not replay of external side effects. File contents, network state, time and other implicit dependencies are not automatically hashed. Include relevant revisions or digests in prompts/keys when fresh execution is required. A task interrupted after a side effect may repeat that effect on replay. Worker tasks that modify shared files need an explicit ownership or serialization strategy; the workflow does not create worktrees or resource leases automatically.

For scripts, `/workflow pause` aborts the interpreter and cancels queued/running workers. Wait for worker cancellation to finish before `/workflow resume`; resume replays with cached completed calls. `/workflow cancel` and `/stop` cancel the whole workflow. Root session, workspace, policy or model changes prevent reuse and further dispatch. Target configuration changes invalidate matching worker cache entries. After restart, unfinished scripts are marked `interrupted`; explicit `replay_script` is supported while the original root binding and deadline remain valid. There is no automatic recovery. An expired workflow must be cancelled and a new one started.

### Interpreter and execution boundaries

QuickJS/WASM runs the script with JSON-only host callbacks, no host objects, process, filesystem, network or module loader. `Date` and `Math.random` are disabled; pass such inputs through `args`. Each interpreter has a 32 MiB guest heap, 512 KiB stack, 100 ms synchronous slices, approximately 2 seconds of guest CPU and 100,000 promise jobs. There are at most four active interpreters per runtime. Source, arguments, worker output and final output have bounded sizes (100,000 characters); status retains at most 50 log entries of 1,000 characters. A deadline/abort signal also terminates scripts awaiting an unresolved promise.

The interpreter boundary does **not** isolate workers: a worker is a normal configured harness under the original authorized profile, workspace and effective permissions. Scripts cannot select another profile or provide environment variables or credentials. Workers may perform only tasks authorized by the goal, and their final answers do not establish that tests or side effects succeeded. The main agent reviews evidence and reports validation limits.
