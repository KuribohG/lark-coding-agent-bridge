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

Create worktrees in batches, not one awaited call after another. Registration is serialized per repository and cheap; writing a checkout's files is the expensive part and runs in a bounded pool, so `parallel` over the whole member list costs roughly one checkout's time plus a wave per 64 worktrees. Awaiting each create turns that into a queue: a workflow that made 80 worktrees serially spent nearly 8 minutes before its first member could start.

The worker must commit intended changes and leave a clean index/worktree. `reviewedAgent` freezes the commit after the worker exits, creates an independent review snapshot, checks that the reviewer left it unchanged, and records approval from the actual task result. Rejection sends feedback to the original member/worktree. With `worker.workspace`, the result adds `{change,approval}` to `{value,review,rounds}`. Without it, existing helper behavior is unchanged. Nested `workflowTool` delegation in a workspace is not supported in this version.

## Worktree, clone or overlay

`createWorkspace({key, isolation})` chooses how far a workspace is separated from the others.

| `isolation` | What the member gets | What it still shares |
| --- | --- | --- |
| `"worktree"` (default) | Its own directory, index and `HEAD`. | The repository's `.git`: branches and other refs, the stash, hooks, config, and Git's maintenance. One member's `git stash pop`, `git gc`, `git worktree prune` or branch update acts on everyone's. |
| `"clone"` | A repository of its own: refs, index, stash, locks and config. | Only objects, which the clone reads from the source checkout through alternates. Nothing is copied, so a clone costs about what a worktree does. |
| `"overlay"` | A clone whose files are not written out: its directory is a mount that shows one checkout of the baseline under the files the member changed. | That checkout, read-only, with every overlay made from the same commit; and objects, as a clone does. |

Use a clone when many members work at once or run Git commands beyond add and commit. Everything else is the same: the clone starts detached at the baseline, freezing, review, `submit_work` and cleanup work as they do for a worktree, and the landing branch is still in the source checkout. The bridge copies a clone's commits to the source when a change is frozen or submitted, and resets the clone to the landed head afterwards.

Inside a clone the source checkout is the remote `bridge-source`, so `git fetch bridge-source` shows its branches (and the landing branch) as `bridge-source/<branch>`. The source's own remotes and their remote-tracking refs are carried over under their names. Members should not push to `bridge-source`.

### Overlay

A worktree or a clone writes every file of the checkout for every member, and deletes them again at cleanup. For a large repository and many members that is most of the time a swarm takes to start, and millions of files on the workspace filesystem. An overlay workspace writes none: the baseline is checked out once for each commit, and each member's directory is a FUSE mount (fuse-overlayfs) of that checkout under a directory of the member's own, which receives whatever the member creates, changes or deletes. Making a workspace then takes about a second whatever the size of the repository, and it holds on disk what its member changed.

In every other respect an overlay is a clone: a repository of its own with `bridge-source` as its remote, frozen, reviewed, landed and cleaned up the same way. Its Git directory is kept outside the mount, so the workspace's `.git` is a file that names it.

Git would normally stat every tracked file to answer `git status`, through the mount. An overlay workspace instead starts from an index made once on the baseline, which records every file as unchanged, and is configured with an fsmonitor hook that lists the member's own directory of changes; Git then looks only at what is listed there. A member's `git status`, `git diff` and `git commit` cost what the change is worth, not what the repository is. `git add -A` and `git clean` are the exception: they read every directory, which is slow the first time in a workspace.

What members should know, and are told in their instructions:

- Writing through the mount is several times slower than on a plain directory. Keep build outputs, caches and other bulky generated files outside the workspace.
- Checking out a commit far from the baseline writes every differing file through the mount. Stay near the baseline; the landing rebases onto the landing branch, which is usually close.
- The mount is served by a process of its own that outlives the bridge. If it dies, the directory answers `Transport endpoint is not connected` until the bridge mounts it again, which it does before the next turn, check or landing that uses the workspace. The member's work is in plain files and is not affected.

Requirements: Linux, `/dev/fuse`, `fusermount3` and `fuse-overlayfs` on the bridge's host. `WORKFLOW_OVERLAY_COMMAND` in the bridge's environment names another executable that takes fuse-overlayfs's arguments, for example a wrapper around a patched build. The workspace directory must be on a filesystem that a FUSE mount may cover and that fuse-overlayfs can keep its changes on; the first overlay a bridge makes tries this out with a small mount, and `createWorkspace` fails with the reason where it does not work. Each mounted workspace is one serving process and one of the FUSE mounts of the bridge's user, of which `fusermount3` allows 1000 unless `/etc/fuse.conf` sets `mount_max`. The baseline checkout is deleted with the last workspace that reads it. Review snapshots and the landing's own worktree remain plain worktrees.

Limits: the source keeps a ref `refs/bridge-workflow/<workflow-id>/clones/<workspace-id>` on what each clone or overlay depends on, removed with the clone; do not delete the source checkout or prune those refs while clones exist. Repositories that are themselves partial clones are refused. Cleanup deletes the clone's directory, subject to the same conditions as a worktree.

## Staffing a running swarm

Declared swarm members take the `workspace` ID of a worktree the script created. Members added while the swarm runs take one too: `staff_swarm({add:['w1','w2'], workspace:true})` creates one worktree per new member and binds it in the same change that adds the member. The new worktree is made like the one of the member it is added `like`: from the same repository, at that repository's current HEAD, and as a clone if that one is a clone. Only when the `like` member has no worktree does it come from the workflow's own directory, which must then be the root of a checkout; under a bridge that directory is often a chat workspace and no checkout at all, and the call says so and asks for `repo`. Pass `{base?,repo?,isolation?}` to choose another commit, repository root or isolation, exactly as `createWorkspace` does. A call that is refused before a worktree exists (no checkout, uncommitted files in it, which the refusal names) leaves nothing behind, so the same member name can be added again with other options. Making the worktrees takes longer than most operations: the call waits for it, and a caller that stopped waiting repeats the same call with the same `operationId`. The main agent and the swarm's lead can both staff; a new member inherits the `like` member's role, queue and execution, and a lead may not choose harness or model. The worktree key is derived from the swarm and member name, so a retried call reuses the worktree it made instead of making another.

A member added without `workspace` runs in the workflow's own checkout: it cannot `submit_work`, and editing code there races the main agent and every other member. Worktrees made this way follow the same retention, cleanup, budget and landing rules as script-made ones.

`staff_swarm({cleanup:'retired'})` (or a list of member names) releases those worktrees once their members are retired, so a long-running swarm does not hold a directory for every member it ever had against the workflow's workspace budget. It is the same host operation as the script's `cleanupWorkspace`: an idle worktree is removed together with any uncommitted or unintegrated work in it, a worktree with a running task is kept with an error, and a worktree the script already removed reports as removed rather than failing. A failed member can be cleaned directly; `revive` runs its turn in the same worktree, and `replace` hands the worktree to the member's new session as the old one left it, so cleaning it is how a run gives up on that member's intermediate work and redoes it. A cleaned member keeps its name but cannot be revived, replaced or given another worktree.

## APIs

Every operation requires an immutable, unique `key` (1–100 characters, no surrounding whitespace or `@` prefix). Keys share the agent/queue/mailbox/control namespace. Each script execution allows 128 workspace calls; each workflow retains at most 4096 workspace keys, 1024 workspaces and 16384 workspace journal records, including internal artifacts.

| API | Result and requirements |
| --- | --- |
| `createWorkspace({key,base?,repo?,isolation?})` | Workspace `{id,path,baseCommit,...}`. `base` is a full commit ID; omitted means resolve the authorized checkout's HEAD once and persist it. Requires a clean repository-root cwd, or `repo`. `isolation` is `"worktree"` (default), `"clone"` or `"overlay"`, see above. |
| `createWorkspace({key,change})` | A separate reviewer worktree pinned to a frozen change ID. Mutually exclusive with `base`, `repo` and `isolation`. |
| `agent(prompt,{key,workspace,...})` / `startAgent(prompt,{key,workspace,...})` | Run in the managed workspace ID. A persistent member cannot change workspace. Only one active task/check/inspection owns a worktree at a time. |
| `freezeWorkspace({key,workspace})` | Immutable `{id,workspaceId,baseCommit,headCommit,tree,diffDigest,files}`. Rejects dirty/untracked files, unfinished Git operations, non-descendant or nonlinear candidate history, whitespace/conflict-marker errors, and a change whose list of paths is over 2 MB. Supervisor-prepared commits can also be frozen. |
| `approveChange({key,change,taskId})` | Approval ID from a successful independent review task in the matching snapshot, reconstructed in the current script run. Requires JSON `{ok:true,reason,evidence:[...]}` from its recorded artifact. |
| `integrateChanges({key,approvals,base?,target?})` | `{workspace,status,headCommit,targetRef,expectedHead,remaining,conflict?}`. Accepts 1–16 distinct approval IDs. `target` is a simple name under `refs/heads/bridge-workflow/<workflow-id>/`, default `result`. Captures the existing target or baseline before combining commits. |
| `checkWorkspace({key,workspace,commands})` | `{id,workspaceId,headCommit,tree,passed,commands}` tied to the clean revision before and after the checks. Each command is `{argv:string[],timeoutMs?}`; first failure stops the sequence. |
| `acceptIntegration({key,workspace,checks})` | `{headCommit,branch,completed:true,...}` after passing checks and a compare-and-swap of the private target. Rejects conflict workspaces, changed revisions, an advanced target, or a target checked out elsewhere. |
| `cleanupWorkspace({key,workspace})` | Removes an unused workspace, discarding uncommitted and unintegrated changes in it. Occupied workspaces (a running task or check) are retained. Candidate refs remain pinned. |

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
- Checks are 1–4 explicit foreground argv commands, no implicit shell. Each has a 100 ms–4 h timeout (default 5 min), capped by the workflow deadline. A check may print any amount; the last 16 KB of its stdout and of its stderr are recorded. Do not launch background daemons: foreground completion does not establish their termination or bind their later writes to the result. Tests that change tracked/untracked files must restore them before returning.
- There is no automatic age-based cleanup, native per-item consumer migration, automatic remote push, or measurement-backed correctness/speed guarantee.

## Public reference

The design follows [Claude Code's worktree isolation and retention model](https://code.claude.com/docs/en/worktrees), including separate working directories, shared Git metadata, retained modified worktrees, and cleanup constraints. The fixed-snapshot approval, persistent operation journal, and checked private integration branch are bridge-specific behavior; they are not asserted to be Claude Code's integration protocol.
