# Workflows

The bridge supports agent-led architecture reviews and script-led workflows. Both keep the main native session and can select worker harnesses independently, including Codex, Claude and Pi when configured with authoritative final-answer support. The main agent can use any supported root harness; it does not have to be Codex.

## Architecture review (P0)

This release adds an agent-led, text-only architecture review prototype. The current Lark topic keeps its main native session. The bridge owns worker runs, so ending a main turn does not terminate its workers. Workers return artifacts to the main session; their output is not sent directly to Lark.

Start with `/workflow start <requirements>`, or explicitly ask the main agent to use the architecture review workflow. The main agent establishes the goal, delegates two independent designers, optionally delegates a challenger, reads their results, and writes a decision report. Ordinary questions do not automatically start a workflow.

`/workflow status` shows the task states and observed worker session IDs. `/workflow pause` stops new dispatch while running workers finish. `/workflow resume` resumes dispatch. `/workflow cancel` cancels workers. `/stop` cancels the workflow and the current main turn. A new root session, workspace, model, backend or policy puts the existing workflow into `binding_attention` and prevents further dispatch.

## Execution contract

- One nonterminal workflow per root scope, at most two workers per workflow, two formal revision rounds, 32 tasks, eight attempts per task, and a 120-minute deadline.
- The shared process pool prioritizes interactive work and reserves one foreground slot when capacity exceeds one. A one-slot host runs stages serially.
- Each designer starts a fresh native session, with only its goal, objective and explicit artifact inputs. Framework artifact access prevents a designer from receiving another designer's output. This is context routing, not filesystem or credential isolation.
- `send` queues a new attempt in the same idle worker session. Busy sessions return an error. P0 does not inject inputs into active workers or reinterpret `unknown` transport receipts.
- Native IDs are recorded only from backend `system` events. Missing history or an unexpected replacement ID fails the task; the framework does not silently substitute a fresh session.
- A bounded, nonempty `final_text` plus normal completion is required for `result_ready`. Progress, interrupted runs and failed output are not accepted as results. Results are unverified text for the main agent to evaluate.
- Results and pending main events commit together in SQLite. An automatic wake uses an internal event prompt and the original reply destination. It neither replays the original user input nor advances its IM cursor. Real follow-ups received during that turn are recorded normally.
- Notification and acknowledgement are separate. The main agent calls `ack_events` after reading results. Unacknowledged events remain in later context. Failed automatic wakes do not enter an unbounded retry loop.

## Main-agent tools

The host injects a short-lived, scope-bound credential and the CLI path for this bridge build. It does not change global CLI configuration. Use:

```sh
node "$LARK_WORKFLOW_CLI" workflow status --json
node "$LARK_WORKFLOW_CLI" workflow delegate --input-file task.json --json
```

The installed `lark-channel-bridge workflow <operation>` also exposes the same protocol. It requires a current bridge run binding. The CLI submits to a loopback IPC service; it does not open the workflow database or own workers. Credentials expire and are revoked when the run ends. Codex daemon bindings are injected through the thread configuration, so concurrent threads do not share a daemon-wide workflow identity.

`start` takes `operationId`, `pluginId: "architecture-review"` and `goal`. Other mutations take `workflowId`, `operationId` and `expectedStateVersion`; read `status` after a conflict. Identical operation IDs return the committed result; conflicting content is rejected. Delegation additionally uses a stable `taskKey`.

P0 operations: `status`, `start`, `delegate`, `send`, `read_artifact`, `publish_artifact`, `ack_events`, `begin_revision_round`, `cancel_task`, `pause`, `resume`, `cancel`, `complete`. Main-authored artifacts support `context` and `architecture-decision`. Completion requires an explicit report reference, an `openIssues` list, `verificationLimits`, no running workers, and no unacknowledged events. Worker bindings can only query their task/context and read explicitly assigned artifacts.

## Boundaries and next stages

### Cross-harness workers (definition 0.2.0-p0)

On builds containing this version, a Codex root may delegate a Pi or Claude worker without changing the root's backend or native session. `delegate` accepts an optional `execution` object:

```json
{
  "workflowId": "<from status>",
  "operationId": "<unique operation ID>",
  "expectedStateVersion": 1,
  "role": "designer-b",
  "actorKey": "pi-designer",
  "taskKey": "alternative-design",
  "objective": "Propose an independent design under the original requirements",
  "inputRefs": [],
  "execution": { "agentKind": "pi", "model": "<model supported by your Pi configuration>", "reasoningEffort": "high" }
}
```

Use the current `stateVersion` from `status`, not the example value. Omit `execution` to inherit the root backend and model settings. With another backend, omitted model settings use that backend's scoped/native defaults, never the root backend's model name. Supply an explicit model to pin the model choice; native defaults are not a frozen model configuration. Every actor records its backend, current profile reference, model overrides, configuration/policy fingerprints and observed native session. No credentials are stored in workflow state.

Targets use the current authorized profile's backend launch configuration and provider registry. Arbitrary profiles, environment variables and credentials are not accepted in `execution`. Effective access cannot exceed the root or target capability; unsupported access modes (for example Pi with a workspace sandbox) are rejected. This does not add filesystem isolation. The target must declare authoritative final answers; unsupported backends fail before spawn. Configuration and authorization are checked again after queue admission and before launch. `send` cannot change execution settings and always resumes the original native session; choose a new actor for another backend. Worker identities remain outside the root session catalog.

Pi emits `final_text` only for the last completed assistant message with a normal stop, after `agent_settled` or a successful legacy JSON-mode process exit. Tool output, retries, interrupted/truncated messages, malformed JSON and failed process exits do not become final answers. Pi input remains request/response, which matches P0's idle-session-only `send` contract.

The versioned definition is `workflow-definitions/architecture-review/workflow.json`; the kernel pins a copy and its digest in each instance. The generic kernel, IPC and worker executor are under `src/workflows`; the command contribution is a static `BridgePlugin` under `src/plugins/workflows`. The Lark host supplies root authorization and main-session wake services. The root native identity remains in `SessionCatalog`; worker identities never write its root slot.

P0 stores evidence across restarts but marks unfinished workflows `interrupted` and does not automatically replay them. Cancel the interrupted instance and explicitly start a new one. A reconnect waits for the old channel to close before the new workflow service opens its database.

P1 will add requirement revisions, explicit replacement/rebinding, durable decisions and reconciled recovery. P2 will add isolated experiments, resource leases and verification records. P0 does not expose a verifier role, enforce schema-based requirement coverage, prove architecture correctness, or enforce read-only shell access. Workers use the same authorized execution profile; their role instructions are not a sandbox. Native internal subagents are not part of the framework's concurrency accounting.

Unit/integration tests exercise state transitions, scope isolation, cancellation races, process admission, CLI bindings, child session continuation and the Lark internal wake path. Real backend validation must additionally cover the installed version; adapter simulations alone do not establish native compatibility.


## Script-led workflows

On builds containing `run_script`, use `/workflow script <task and preferred harnesses>` or ask the main agent to write and run a script workflow. The main agent creates the script and submits it; the bridge executes it independently of that agent's turn. This feature is a bridge implementation using QuickJS, not a Claude-only tool or a wrapper around Claude's workflow runtime. It is independent of the `architecture-review` plugin.

A script is a JavaScript **function body** with top-level `await` and `return`. Control flow is ordinary JavaScript: a worker's result can select a branch, create more calls, or feed subsequent stages. No static graph needs to be declared. See [the cross-harness review example](../workflow-definitions/scripted/examples/review.js).

```js
const [proposal, constraints] = await parallel([
  () => agent(args.subject, { key: 'proposal', harness: 'pi' }),
  () => agent('List constraints: ' + args.subject, { key: 'constraints', harness: 'claude' }),
]);
return await agent(JSON.stringify({ proposal, constraints }), {
  key: 'decision', harness: 'codex',
});
```

Submit a JSON envelope using the existing scope-bound CLI:

```sh
node "$LARK_WORKFLOW_CLI" workflow run_script --input-file workflow.json --json
```

The envelope has `operationId`, `goal` (the full authorized task) and `script` (the function body as a string). Optional fields:

| Field | Meaning |
| --- | --- |
| `name` | Display name, up to 100 characters |
| `args` | JSON data exposed as `args` in the interpreter |
| `execution` | Default `{agentKind, model?, reasoningEffort?}`; otherwise root harness/settings |
| `maxAgents` | Calls per script run, default 32, maximum 128; cache hits count |
| `maxConcurrent` | Concurrent workers per workflow, default 4, maximum 16; shared process-pool limits also apply |
| `timeoutMs` | Total workflow deadline, default 30 minutes, range 1 second to 120 minutes; replay does not extend it |

Guest functions:

| API | Behavior |
| --- | --- |
| `agent(prompt, {key, harness?, model?, reasoningEffort?, output?})` | Promise of final text, or a parsed JSON value with `output: "json"` |
| `parallel([() => ..., () => ...])` | Starts functions and returns results in input order |
| `pipeline(items, ...stages)` | Processes items concurrently; each item passes through its stages sequentially as `stage(value, index)` |
| `phase(text)` / `log(text)` | Bounded progress recorded in status; does not wake main |

`key` is required, stable across replay, and unique within one run. A selected harness uses its configured defaults unless model/effort overrides are supplied. Switching harness does not inherit a different harness's model. All calls must be awaited; the interpreter rejects a result while agent calls are still pending. Failures reject promises, including invalid JSON, missing final answers, native questions and unsupported harnesses. `parallel` and `pipeline` reject on failure; use explicit `try/catch` to implement a fallback. JSON parsing does not validate a schema: check required fields in the script.

Only script completion/failure creates a main-agent event, rather than an event for every worker. Final return values are serialized into a `workflow-result` artifact; no return means JSON `null`. The main agent reads the artifact, acknowledges events, and calls `complete` with that artifact reference, `openIssues` and `verificationLimits`. Workers cannot mutate workflow state, send parent answers, or recursively delegate through the workflow API. Manual `delegate` and `send` are rejected in script-led workflows.

### Replay and lifecycle

`replay_script` requires the usual `workflowId`, unique `operationId` and current `expectedStateVersion`. It optionally replaces `script`, `args` or `execution`, and restarts the function from its beginning. Completed calls are reused by a fingerprint of **key, prompt, output mode, resolved worker binding, root binding, goal and workflow definition**. Changing execution order alone does not invalidate unrelated calls. Changing a prompt or harness reruns that call in a fresh worker session; downstream calls rerun when the data in their prompts changes. Failed, cancelled, interrupted or waiting-for-input tasks are never reused. Up to eight replays and 128 total task attempts are retained per workflow.

This is result reuse, not replay of external side effects. File contents, network state, time and other implicit dependencies are not automatically hashed. Include relevant revisions or digests in prompts/keys when fresh execution is required. A task interrupted after a side effect may repeat that effect on replay. Worker tasks that modify shared files need an explicit ownership or serialization strategy; the workflow does not create worktrees or resource leases automatically.

For scripts, `/workflow pause` aborts the interpreter and cancels queued/running workers. Wait for worker cancellation to finish before `/workflow resume`; resume replays with cached completed calls. `/workflow cancel` and `/stop` cancel the whole workflow. The architecture-review pause behavior stays as documented above. Root session, workspace, policy or model changes prevent reuse and further dispatch. Target configuration changes invalidate matching worker cache entries. After restart, unfinished scripts are marked `interrupted`; explicit `replay_script` is supported while the original root binding and deadline remain valid. There is no automatic recovery. An expired workflow must be cancelled and a new one started.

### Interpreter and execution boundaries

QuickJS/WASM runs the script with JSON-only host callbacks, no host objects, process, filesystem, network or module loader. `Date` and `Math.random` are disabled; pass such inputs through `args`. Each interpreter has a 32 MiB guest heap, 512 KiB stack, 100 ms synchronous slices, approximately 2 seconds of guest CPU and 100,000 promise jobs. There are at most four active interpreters per runtime. Source, arguments, worker output and final output have bounded sizes (100,000 characters); status retains at most 50 log entries of 1,000 characters. A deadline/abort signal also terminates scripts awaiting an unresolved promise.

The interpreter boundary does **not** isolate workers: a worker is a normal configured harness under the original authorized profile, workspace and effective permissions. Scripts cannot select another profile or provide environment variables or credentials. Workers may perform only tasks authorized by the goal, and their final answers do not establish that tests or side effects succeeded. The main agent reviews evidence and reports validation limits.
