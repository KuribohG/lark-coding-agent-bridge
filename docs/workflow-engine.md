# Embedding the workflow engine

The script-led workflow engine behind `/workflow` is published as `lark-channel-bridge/workflows`. It has no dependency on Lark, the bridge configuration or its agent backends: a host supplies an agent runner and authorization callbacks, and the engine handles scripts, durable state, replay, mailboxes, work queues, nested workflows and managed Git worktrees.

## Layers

| Path | Role | May import |
| --- | --- | --- |
| `src/workflows/engine` | Kernel (SQLite state), script VM, runtime, worker IPC, worktrees | Node built-ins, `better-sqlite3`, `quickjs-emscripten` |
| `src/workflows/chat` | `/workflow` command text and status rendering | `engine` |
| `src/workflows/bridge` | Bridge adapter: `RunExecutor` runner, run-policy and full-access checks, backend/model/effort validation | Anything |
| `src/workflows/index.ts` | Public entry (`engine` + `chat`) | `engine`, `chat` |

`tests/static/contracts.test.ts` enforces the engine and chat import rules.

## Minimal host

```ts
import { WorkflowRuntime, type WorkflowRoot } from 'lark-channel-bridge/workflows';

const runtime = new WorkflowRuntime({
  path: '/var/lib/my-host/workflows.sqlite',
  // Current authorization of a main session. Return undefined, or a root with a different digest, to revoke it.
  resolveRoot: async scopeId => rootFor(scopeId),
  // Starts one agent turn; see WorkerRunSpec / WorkerRun.
  runner: myRunner,
  // Called when a child result or event needs the main agent's attention.
  wakeMain: async scopeId => scheduleMainTurn(scopeId),
  // Optional:
  checkSelection: selection => { /* reject unknown harness / model / effort names */ },
  // Defaults to inheritedWorkerExecution, which keeps workers on the root's harness.
  resolveWorker: async (root, selection) => myWorkerExecution(root, selection),
  authorizeWorkspace: async (root, worker) => { /* allow managed worktrees, or omit to disable */ },
  log: myLogger,
});
await runtime.start();

// Main-agent turn that may create a workflow:
const binding = runtime.bindMain(scopeId, 'start');
// Give binding.env to the main agent process and binding.instructions to its system prompt.
// Call binding.release() when the turn ends.
```

The main agent and workers call workflow operations through `node "$LARK_WORKFLOW_CLI" workflow <operation> --input '<JSON>' --json`. `binding.env` carries a per-run endpoint and token, plus the CLI path (`cliPath`, defaulting to the packaged `dist/cli.js`). The token is the only credential: each binding is scoped to one caller and is revoked on release.

## Runner contract

`runner.start(spec)` launches one agent turn and resolves after it has been admitted:

- Pass `spec.env` to the agent process and use `spec.systemPrompt` as additional system instructions. If `spec.workspace` is set, use `spec.workspace.path` as the working directory.
- Call `await spec.validateBeforeRun()` after any queueing and before starting the agent. It throws when the binding or worktree is stale.
- When `spec.resume` is set, continue that native session (`kind` names the backend's session-ID field).
- `events()` yields `session` (the native session ID, needed for durable members), `final_text`, `error`, `retry` (discards earlier text), `done` with `normal`, and `user_input` (the engine stops the turn and records the question).
- `result` resolves to `completed`, `stopped` or `failed`. A turn produces a result only when it completes with `done.normal` and has `final_text`.
- `spec.signal` aborts with `WorkflowStopped`; use `stopReasonOf(signal)` to read the reason.
- With worktrees, `waitForExit` must report process exit truthfully. If exit is uncertain, the engine retains the worktree and blocks further use.

## Authorization model

The engine pins a `WorkflowRoot` (profile, harness, cwd, policy fingerprint, model settings) when a workflow is created. Before each worker starts and again after admission, it compares `workflowDigest(root)` with `resolveRoot`, and the worker's `WorkerExecution` with `resolveWorker`. Any change stops new work. Hosts decide what is authorized. The engine never chooses credentials, profiles or permissions for a worker.

The bridge adapter (`createBridgeWorkflowRuntime`) shows a complete implementation: it maps workers onto `RunExecutor`, derives worker run policies from the root policy, and allows worktrees only for full-access roots.

## Current limits

- The worker CLI and its environment variables still use the `LARK_WORKFLOW_*` names, and the shipped CLI is the full bridge CLI.
- Command, status and restart texts are in Chinese. Hosts can render their own UI from `runtime.kernel.state()`.
