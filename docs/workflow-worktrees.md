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

`createWorkspace` answers once the worktree is recorded; its files are written afterwards, and whoever is to work in it is held back until they are there (see [Starting before every worktree is written](#starting-before-every-worktree-is-written)). Registration is serialized per repository and cheap, so creating the worktrees of a whole member list takes seconds, in `parallel` or one after another. With `wait:true` a call waits for the files: awaiting such calls one after another turns the checkouts into a queue.

The worker must commit intended changes and leave a clean index/worktree. `reviewedAgent` freezes the commit after the worker exits, creates an independent review snapshot, checks that the reviewer left it unchanged, and records approval from the actual task result. Rejection sends feedback to the original member/worktree. With `worker.workspace`, the result adds `{change,approval}` to `{value,review,rounds}`. Without it, existing helper behavior is unchanged. Nested `workflowTool` delegation in a workspace is not supported in this version.

## Worktree or clone

`createWorkspace({key, isolation})` chooses how far a workspace is separated from the others.

| `isolation` | What the member gets | What it still shares |
| --- | --- | --- |
| `"worktree"` (default) | Its own directory, index and `HEAD`. | The repository's `.git`: branches and other refs, the stash, hooks, config, and Git's maintenance. One member's `git stash pop`, `git gc`, `git worktree prune` or branch update acts on everyone's. |
| `"clone"` | A repository of its own: refs, index, stash, locks and config. | Only objects, which the clone reads from the source checkout through alternates. Nothing is copied, so a clone costs about what a worktree does. |
| `"wsfs"` | A worktree whose files are not written: its directory shows the commit as it is read from the object database, and stores only what the member changes. | What a worktree shares. See [Workspaces served from the object database](#workspaces-served-from-the-object-database). |

Use a clone when many members work at once or run Git commands beyond add and commit. Everything else is the same: the clone starts detached at the baseline, freezing, review, `submit_work` and cleanup work as they do for a worktree, and the landing branch is still in the source checkout. The bridge copies a clone's commits to the source when a change is frozen or submitted, and resets the clone to the landed head afterwards.

Inside a clone the source checkout is the remote `bridge-source`, so `git fetch bridge-source` shows its branches (and the landing branch) as `bridge-source/<branch>`. The source's own remotes and their remote-tracking refs are carried over under their names. Members should not push to `bridge-source`.

Limits: the source keeps a ref `refs/bridge-workflow/<workflow-id>/clones/<workspace-id>` on what each clone depends on, removed with the clone; do not delete the source checkout or prune those refs while clones exist. Repositories that are themselves partial clones are refused. Cleanup deletes the clone's directory, subject to the same conditions as a worktree.

## Workspaces served from the object database

A worktree or a clone of a large repository costs a checkout: every file of the commit is written before a member can start, and written again, file by file, each time the member's commits are rebased onto what others landed. `createWorkspace({key, isolation: "wsfs"})` and `staff_swarm({add, workspace: {isolation: "wsfs"}})` make a workspace that has no checkout. Its directory is served by `wsfs` ([packages/workspace-fs](../packages/workspace-fs/README.md)), a FUSE filesystem that reads files from the repository's object database as they are opened and keeps, as plain files, only what the workspace itself changed or built.

- Making one writes an index and nothing else. On a repository of 125,000 files on a network filesystem, on a busy machine, 24 workspaces asked for at once were ready within three seconds; a worktree there takes about half a minute, written by 64 processes.
- `submit_work` rebases the member's commits in the object database and moves the workspace to the result, and afterwards to the head of the landing branch; no file is written for either. On that repository a submission took four to five seconds up to the answer of the queue, with a check that does nothing. The files of the commits that landed are dropped from the workspace, so what it holds does not grow as the member follows the branch. Untracked files, a build directory among them, stay where they are.
- The landing queue's own worktree is a workspace of the same kind, so the checks do not wait for a checkout either. With `train_directory` set in the bridge's [`[workflow]` table](configuration.md#workflows-and-the-machine) it is a plain worktree in that directory instead: on a local disk the checkout is cheap, and what the checks build is then written to that disk and not through the daemon.
- The member's Git works as in any linked worktree of the repository: branches, the stash and the object database are the repository's. A member that puts its `HEAD` on a branch of its own, or whose commits are not a plain line, is rebased by Git in the workspace as in a worktree; that works and writes the files that differ.

One daemon serves the workspaces of one workflow in one repository, at `<worktrees>/<workflow-id>/wsfs-<repository>/<workspace-id>`. It is started with the first workspace and stopped with the last one that is cleaned up, and it is a process of its own: members keep working across a restart of the bridge. If it dies, the bridge starts it again within a few seconds of noticing, and nothing is lost, since a workspace's changes are plain files; commands that were running in its workspaces at that moment fail with `Transport endpoint is not connected`, and a member's shell has to enter its directory again.

Requirements and limits:

- Linux with `/dev/fuse` and `fusermount3` (package `fuse3`), and the `wsfs` binary. `pnpm install` builds it into `bin/wsfs` when `cargo` (Rust 1.93 or later) is on `PATH`; `WORKFLOW_WSFS_COMMAND` names another binary. Where any of these is missing the creation is refused with the reason, before anything is recorded, and the same key can be asked for with another isolation.
- What the workspaces change is stored under `<worktrees>/<workflow-id>/wsfs-<repository>.state/`, on the filesystem the worktrees are on, so creating a file in a workspace costs what creating one there costs. `wsfs_state_directory` in the bridge's [`[workflow]` table](configuration.md#workflows-and-the-machine) names another root, for instance a directory on a local disk where a build is as fast as a local build and does not survive the machine. The setting is read when a workflow's first workspace in a repository is made.
- A repository whose shared configuration turns sparse checkout on, a partial clone and a SHA-256 repository are refused. Like every workspace, one whose commit has submodules or checkout filters is refused too.
- No hard links. Renaming a directory that holds committed files is refused as a rename across filesystems, and `mv` then copies and deletes. `git mv` does not copy and fails with `Invalid cross-device link`: such a directory is moved with `mv` and staged with `git add -A <old> <new>`, which Git records as the same renames, and members are told so. Files are served as the commit stores them, without end-of-line or encoding conversion.
- Review snapshots and integration worktrees (`createWorkspace({key, change})`, `integrateChanges`) are plain worktrees.

## Starting before every worktree is written

Writing the files is what makes a workspace slow on a large repository, and a swarm does not need every member's worktree before its first member can work. `createWorkspace({key})` therefore answers as soon as the worktree is recorded, with `status: "preparing"`, and its files are written afterwards. The ID is given to a swarm member like any other: the swarm holds that member back and wakes it when its worktree is ready. Members whose worktrees are ready work meanwhile, and the work items go to them, since a member that has not been woken has claimed nothing.

```js
const names = ['w1', 'w2', 'w3'];
const [own, ...spaces] = await parallel(['lead', ...names].map(name => () => createWorkspace({key: 'ws-' + name})));
return await swarm(goal, {key: 'crew', lead: {name: 'lead', workspace: own.id}, members: names.map((name, n) => ({name, workspace: spaces[n].id}))});
```

The worktrees that are written first are those somebody has work to do in. On every scheduling pass the swarm names the members that have something to do and are held back only by their worktree: a lead that is to plan, a member with an item kept for it or with messages, and of the members of a queue as many as it has items nobody was woken for. Their worktrees take the next turns, the leads' before the others', both to be registered and to have their files written; so does a worktree that `agent()` or `freezeWorkspace` is waiting for. The others follow in about the order they were asked for, so no turn goes unused. The order follows the work: when the lead enqueues items, the members that can claim them move ahead.

- A checkout of 2,000 files or more is written by 64 Git processes, each a stretch of its files, and one such checkout at a time. One Git process writes a checkout file by file, and on a network filesystem each file takes several round trips whatever else runs beside it: 134,000 files took twenty minutes that way, with one other checkout running or with sixty-three, and half a minute with 64 processes on the one checkout. The worktrees of a swarm therefore become ready one after another from the first minute. Smaller checkouts and sparse ones are written by Git alone as before, and do not wait for a large checkout's turn.
- A process that fails to write its stretch of a large checkout, or is killed, has the stretch given to another, up to three times. A worktree whose files cannot be written then makes its member stop as failed, with the reason. Whoever answers for the swarm's members is told as for any failed member: `staff_swarm({revive})` has the files written again, and `cleanup` removes what was made.
- When the bridge restarts, a worktree that was not finished is written again the next time the swarm looks at its member, and registered again if the restart stopped Git while it was registering it. A workflow that is cancelled or has ended stops writing its worktrees.
- `agent(prompt, {workspace})` with a worktree that is still being prepared waits for it, and so do `freezeWorkspace`, `checkWorkspace` and `acceptIntegration`. `cleanupWorkspace` does not: it stops the writing and removes what there is.
- `createWorkspace({key, wait:true})` answers only when the files are written, with `status: "ready"`, and fails if they cannot be. `wait` is no part of what a key stands for: the same key asked for again gives the same worktree.

## Staffing a running swarm

Declared swarm members take the `workspace` ID of a worktree the script created. Members added while the swarm runs take one too: `staff_swarm({add:['w1','w2'], workspace:true})` creates one worktree per new member and binds it in the same change that adds the member. The new worktree is made like the one of the member it is added `like`: from the same repository, at that repository's current HEAD, and as a clone if that one is a clone. Only when the `like` member has no worktree does it come from the workflow's own directory, which must then be the root of a checkout; under a bridge that directory is often a chat workspace and no checkout at all, and the call says so and asks for `repo`. Pass `{base?,repo?,isolation?}` to choose another commit, repository root or isolation, exactly as `createWorkspace` does. A call that is refused before a worktree exists (no checkout, uncommitted files in it, which the refusal names) leaves nothing behind, so the same member name can be added again with other options. The call does not wait for the files of the new worktrees: it records them, adds the members and answers, and each member takes its first turn when its own worktree is ready (see above), in the order the members are named. The main agent and the swarm's lead can both staff; a new member inherits the `like` member's role, queue and execution, and a lead may not choose harness or model. The worktree key is derived from the swarm and member name, so a retried call reuses the worktree it made instead of making another.

A member added without `workspace` runs in the workflow's own checkout: it cannot `submit_work`, and editing code there races the main agent and every other member. Worktrees made this way follow the same retention, cleanup, budget and landing rules as script-made ones.

`staff_swarm({cleanup:'retired'})` (or a list of member names) releases those worktrees once their members are retired, so a long-running swarm does not hold a directory for every member it ever had against the workflow's workspace budget. It is the same host operation as the script's `cleanupWorkspace`: an idle worktree is removed together with any uncommitted or unintegrated work in it, a worktree with a running task is kept with an error, and a worktree the script already removed reports as removed rather than failing. A failed member can be cleaned directly; `revive` runs its turn in the same worktree, and `replace` hands the worktree to the member's new session as the old one left it, so cleaning it is how a run gives up on that member's intermediate work and redoes it. A cleaned member keeps its name but cannot be revived, replaced or given another worktree.

## APIs

Every operation requires an immutable, unique `key` (1–100 characters, no surrounding whitespace or `@` prefix). Keys share the agent/queue/mailbox/control namespace. Each script execution allows 128 workspace calls; each workflow retains at most 4096 workspace keys, 1024 workspaces and 16384 workspace journal records, including internal artifacts.

| API | Result and requirements |
| --- | --- |
| `createWorkspace({key,base?,repo?,isolation?,wait?})` | Workspace `{id,path,baseCommit,status,...}`. `base` is a full commit ID; omitted means resolve the authorized checkout's HEAD once and persist it. Requires a clean repository-root cwd, or `repo`. `isolation` is `"worktree"` (default), `"clone"` or `"wsfs"`, see above. The answer comes before the files are written, with `status: "preparing"`; `wait:true` waits for them. See above. |
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
