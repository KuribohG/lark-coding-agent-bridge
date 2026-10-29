# Architecture review workflow (P0)

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

The versioned definition is `workflow-definitions/architecture-review/workflow.json`; the kernel pins a copy and its digest in each instance. The generic kernel, IPC and worker executor are under `src/workflows`; the command contribution is a static `BridgePlugin` under `src/plugins/workflows`. The Lark host supplies root authorization and main-session wake services. The root native identity remains in `SessionCatalog`; worker identities never write its root slot.

P0 stores evidence across restarts but marks unfinished workflows `interrupted` and does not automatically replay them. Cancel the interrupted instance and explicitly start a new one. A reconnect waits for the old channel to close before the new workflow service opens its database.

P1 will add requirement revisions, explicit replacement/rebinding, durable decisions and reconciled recovery. P2 will add isolated experiments, resource leases and verification records. P0 does not expose a verifier role, enforce schema-based requirement coverage, prove architecture correctness, or enforce read-only shell access. Workers use the same authorized execution profile; their role instructions are not a sandbox. Native internal subagents are not part of the framework's concurrency accounting.

Unit/integration tests exercise state transitions, scope isolation, cancellation races, process admission, CLI bindings, child session continuation and the Lark internal wake path. Real backend validation must additionally cover the installed version; adapter simulations alone do not establish native compatibility.
