# Isolated coding workspaces and checked integration

Use managed worktrees when independent workers need to edit a Git repository concurrently. Read-only research and small sequential changes can keep using ordinary `agent()` calls. This is opt-in: ordinary chat does not start a workflow.

A coding worker receives a detached worktree and a fixed baseline. An independent reviewer receives a separate snapshot at the candidate commit. Integration combines approved commits in another worktree, runs checks there, and advances a **private workflow branch** only if those exact commits passed. The original checkout and remote branches are not updated by these APIs.

## Typical script

```js
const workspace = await createWorkspace({key: 'implementation'});
const result = await reviewedAgent(args.task, {
  key: 'change', criteria: args.criteria,
  worker: {...args.implementer, workspace: workspace.id},
  reviewer: args.verifier,
  maxRounds: 2,
});
const integration = await integrateChanges({
  key: 'integration', approvals: [result.approval.id],
});
if (integration.status === 'conflict') return integration;
const checks = await checkWorkspace({
  key: 'integration-checks', workspace: integration.workspace.id,
  commands: args.checks, // e.g. [{argv: ['npm', 'test'], timeoutMs: 300000}]
});
return await acceptIntegration({
  key: 'accept', workspace: integration.workspace.id, checks: checks.id,
});
```

Pass explicit worker `harness`, `model`, and `reasoningEffort` values appropriate to the task. Independent changes can run the create/review sequence inside `parallel`, with unique keys and members. Example: [parallel reviewed changes](../workflow-definitions/scripted/examples/isolated-implementation.js).

The worker must commit intended changes and leave a clean index/worktree. `reviewedAgent` freezes the commit after the worker exits, creates an independent review snapshot, checks that the reviewer left it unchanged, and records approval from the actual task result. Rejection sends feedback to the original member/worktree. With `worker.workspace`, the result adds `{change,approval}` to `{value,review,rounds}`. Without it, existing helper behavior is unchanged. Nested `workflowTool` delegation and consumer-pool workspace switching are not supported in this version.

## APIs

Every operation requires an immutable, unique `key` (1–100 characters, no surrounding whitespace or `@` prefix). Keys share the agent/queue/mailbox/control namespace. Each script execution allows 128 workspace calls; each workflow retains at most 256 workspace keys, 32 workspaces and 512 workspace journal records, including internal artifacts.

| API | Result and requirements |
| --- | --- |
| `createWorkspace({key,base?})` | Workspace `{id,path,baseCommit,...}`. `base` is a full commit ID; omitted means resolve the authorized checkout's HEAD once and persist it. Requires a clean repository-root cwd. |
| `createWorkspace({key,change})` | A separate reviewer worktree pinned to a frozen change ID. Mutually exclusive with `base`. |
| `agent(prompt,{key,workspace,...})` / `startAgent(prompt,{key,workspace,...})` | Run in the managed workspace ID. A persistent member cannot change workspace. Only one active task/check/inspection owns a worktree at a time. |
| `freezeWorkspace({key,workspace})` | Immutable `{id,workspaceId,baseCommit,headCommit,tree,diffDigest,files}`. Rejects dirty/untracked files, unfinished Git operations, non-descendant or nonlinear candidate history, and whitespace/conflict-marker errors. Supervisor-prepared commits can also be frozen. |
| `approveChange({key,change,taskId})` | Approval ID from a successful independent review task in the matching snapshot, reconstructed in the current script run. Requires JSON `{ok:true,reason,evidence:[...]}` from its recorded artifact. |
| `integrateChanges({key,approvals,base?,target?})` | `{workspace,status,headCommit,targetRef,expectedHead,remaining,conflict?}`. Accepts 1–16 distinct approval IDs. `target` is a simple name under `refs/heads/bridge-workflow/<workflow-id>/`, default `result`. Captures the existing target or baseline before combining commits. |
| `checkWorkspace({key,workspace,commands})` | `{id,workspaceId,headCommit,tree,passed,commands}` tied to the clean revision before and after the checks. Each command is `{argv:string[],timeoutMs?}`; first failure stops the sequence. |
| `acceptIntegration({key,workspace,checks})` | `{headCommit,branch,completed:true,...}` after passing checks and a compare-and-swap of the private target. Rejects conflict workspaces, changed revisions, an advanced target, or a target checked out elsewhere. |
| `cleanupWorkspace({key,workspace})` | Removes a clean, unused workspace only if unchanged from its baseline or its exact integration head was accepted. Modified/unintegrated/occupied workspaces are retained. Candidate refs remain pinned. |

Integration preserves ancestry with deterministic merge commits. A change's baseline must already be an ancestor of the integration head: integrate dependencies first. Merging cleanly is insufficient; combined behavior must pass checks. Checks may inspect another candidate too, but only checks for the actual prepared integration can authorize acceptance. A changed integration needs another freeze/review/integration, not just another passing command.

## Conflicts and failed checks

A textual conflict returns `status:'conflict'` and retains a worktree containing the conflicted merge tree. It cannot be accepted. `remaining` contains approvals not yet attempted. Run `reviewedAgent` in that integration worktree to repair the combined code and commit it, then prepare a **new** integration from the repair approval followed by `remaining`. The repair reviewer sees the complete combined diff against the integration baseline. Repeated conflicts require another bounded repair round.

Failed checks cannot authorize acceptance. Inspect their output, correct the combination in the integration worktree, freeze/review it, then prepare and check a new integration. Use new keys for new attempts. Explicitly publishing to a user branch/remote is a separate authorized Git operation by the main agent, using the returned commit.

## Replay, retention and execution boundaries

The SQLite journal stores operation intent before Git effects and immutable results afterward. Replaying a completed call with the same inputs returns the original result. New keys are required to re-run checks after dependency, environment or external-service changes: the check record covers the Git revision and argv, not external state. Replay does not refresh cached approvals or test results. An interrupted check without a recorded result runs again; check commands must tolerate retries. Helper keys additionally reserve `/freeze/<round>`, `/snapshot/<round>`, and `/approve/<round>`.

Workers keep a durable worktree lease until the native adapter confirms exit. Checks keep it until the foreground process closes. Clean cancellation releases ownership; uncertain native termination or a hard bridge crash leaves ownership blocked and preserves the worktree. This release does not attempt to prove or terminate surviving native descendants after a bridge crash. Recover using a new worktree/key from a known frozen revision, or have an operator establish termination before recovery; it never clears a lease merely because a recorded PID disappeared. A remove-before-journal crash can be reconciled only for the matching cleanup intent and an absent, unregistered worktree. No broad `git worktree prune` or force deletion is performed.

Requirements and bounds:

- Git 2.38+ and an already authorized full-access profile. Both root and selected-worker policies must remain unrestricted; the API does not upgrade restricted profiles. The managed cwd is derived only after checking workflow/root/repository ownership.
- Worktrees share Git metadata and host filesystem permissions. They prevent accidental working-file collisions; they are **not a security sandbox** against an adversarial agent. Review integrity is checked at execution boundaries. The model's evidence remains a judgment, so use deterministic integration checks where practical.
- Submodules and checkout filters/Git LFS are outside this version's supported scope. Repository hooks are disabled for manager Git commands. Dependencies and ignored build output are not copied from the original checkout; prepare them in each worktree. Shared caches require tooling-specific concurrency safety.
- Checks are 1–4 explicit foreground argv commands, no implicit shell. Each has a 100 ms–30 min timeout (default 5 min), capped by the workflow deadline. Output is bounded to 2 MB per command; recorded stdout/stderr tails are 16 KB each. Do not launch background daemons: foreground completion does not establish their termination or bind their later writes to the result. Tests that change tracked/untracked files must restore them before returning.
- There is no automatic age-based cleanup, native per-item consumer migration, automatic remote push, or measurement-backed correctness/speed guarantee.

## Public reference

The design follows [Claude Code's worktree isolation and retention model](https://code.claude.com/docs/en/worktrees), including separate working directories, shared Git metadata, retained modified worktrees, and cleanup constraints. The fixed-snapshot approval, persistent operation journal, and checked private integration branch are bridge-specific behavior; they are not asserted to be Claude Code's integration protocol.
