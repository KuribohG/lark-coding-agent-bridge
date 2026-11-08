# @kuribohg/agent-workflows

Durable, script-led multi-agent workflows for coding-agent hosts. This is the engine behind `/workflow` in [lark-channel-bridge](../../README.md). It has no dependency on Lark or on any agent backend. A host supplies an agent runner and authorization callbacks; the engine handles scripts, durable state, replay, mailboxes, work queues, nested workflows and managed Git worktrees.

The package is developed in the bridge repository and is not yet published on its own. Until it is, the bridge bundles it and re-exports the same API as `lark-channel-bridge/workflows`.

## Layout

| Path | Role |
| --- | --- |
| `src/engine` | Kernel (SQLite state), script VM, runtime, worker IPC, worktrees |
| `src/chat` | `/workflow` command text and status rendering |
| `src/index.ts` | Public API |
| `src/cli.ts` | Worker CLI (`agent-workflow workflow <operation>`) |

Runtime dependencies are `better-sqlite3` and `quickjs-emscripten` only. The bridge's `tests/static/contracts.test.ts` enforces this and keeps the bridge on the public entry. In this repository, `pnpm --filter @kuribohg/agent-workflows build|test|typecheck` works on the package alone; the bridge's root `test` and `typecheck` include it.

## Minimal host

```ts
import { WorkflowRuntime } from '@kuribohg/agent-workflows';

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

The main agent and workers call workflow operations through `node "$AGENT_WORKFLOW_CLI" workflow <operation> --input '<JSON>' --json`. `binding.env` carries a per-run endpoint and token, plus the CLI path (`cliPath`, defaulting to `cli.js` beside the bundle: this package's worker CLI, or the bridge CLI when bundled into the bridge; both accept the same command). The token is the only credential: each binding is scoped to one caller and is revoked on release.

## Runner contract

`runner.start(spec)` launches one agent turn and resolves after it has been admitted:

- Pass `spec.env` to the agent process and use `spec.systemPrompt` as additional system instructions. If `spec.workspace` is set, use `spec.workspace.path` as the working directory.
- Call `await spec.validateBeforeRun()` after any queueing and before starting the agent. It throws when the binding or worktree is stale. The engine records the call as the attempt's `admittedAt`, so call it as soon as the host grants an execution slot; without it, slot queueing is indistinguishable from execution time.
- When `spec.resume` is set, continue that native session (`kind` names the backend's session-ID field).
- `events()` yields `session` (the native session ID, needed for durable members), `final_text`, `error`, `retry` (discards earlier text), `done` with `normal`, and `user_input` (the engine stops the turn and records the question).
- `result` resolves to `completed`, `stopped` or `failed`. A turn produces a result only when it completes with `done.normal` and has `final_text`.
- `spec.signal` aborts with `WorkflowStopped`; use `stopReasonOf(signal)` to read the reason.
- Optionally, `runner.hosting` lets workers outlive the host process. The engine then passes `spec.host = { key, attach }`: a run stopped for `shutdown` must keep its process running under that key, and a later `start` with `attach: true` replays its output from the start and continues it instead of spawning. `hosting.attachable` and `hosting.release` probe and end such processes. The engine records hosts in its database and attaches them when a replay reaches the same turn; worktree turns and turns holding a work claim never attach.
- With worktrees, `waitForExit` must report process exit truthfully. If exit is uncertain, the engine retains the worktree and blocks further use.

## Authorization model

The engine pins a `WorkflowRoot` (profile, harness, cwd, policy fingerprint, model settings) when a workflow is created. Before each worker starts and again after admission, it compares `workflowDigest(root)` with `resolveRoot`, and the worker's `WorkerExecution` with `resolveWorker`. Any change stops new work. Hosts decide what is authorized. The engine never chooses credentials, profiles or permissions for a worker.

The bridge adapter (`src/workflows/bridge` in the bridge repository) is a complete implementation: it maps workers onto `RunExecutor`, derives worker run policies from the root policy, and allows worktrees only for full-access roots.

## Current limits

- Command, status and restart texts are in Chinese, as are the main-agent tool instructions and the role instructions prepended to every worker prompt. Hosts can render their own UI from `runtime.kernel.state()`, but cannot yet replace the text the engine sends to agents.
