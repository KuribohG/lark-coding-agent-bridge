# Workflow scheduling controls

Scripts can route different kinds of work to separate consumer pools, wait for evidence without polling, and stop redundant task branches. These APIs are additive: existing scripts use the `default` queue and keep the existing `agent()` and mailbox behavior.

## Routed work and dependencies

`enqueueWork` accepts `queue`, `priority` and `dependsOn`. Queue names are case-sensitive identifiers of 1–64 letters, digits, underscores or hyphens, starting with a letter; `parent`, `constructor` and `prototype` are reserved. Work keys remain unique across the entire workflow.

`dependsOn` contains existing work **keys**, not item IDs. Enqueue prerequisites first. Dependencies can cross queues and require successful completion; failed or cancelled prerequisites stop the affected pool with a diagnostic. Repair/retry the prerequisite and explicitly replay. The immutable, backward-only dependency graph cannot contain cycles. Results of dependencies remain available through `work_status({itemId})`; dependency completion does not implicitly copy results into an item's immutable input.

Each pool has its own prompt, worker bindings and optional `maxConcurrent`. Members belong to exactly one pool, and claims are restricted to that pool's queue. Within a queue, priority ranges from -100 to 100 (default 0); higher values run first, with FIFO ties. Priority does not preempt an active claim or guarantee fairness under a continuing stream of higher-priority arrivals. Resource keys exclude overlapping claims across **all** queues of the workflow.

```js
const implementation = await enqueueWork({
  key: 'implement-parser', queue: 'implementation', title: 'Implement the parser change',
  input: args.change, resources: ['worktree:parser'],
});
await enqueueWork({
  key: 'review-parser', queue: 'review', title: 'Verify the parser change',
  input: {implementationItemId: implementation.itemId}, dependsOn: ['implement-parser'],
});
await closeWorkQueue({key: 'implementation-closed', queue: 'implementation'});
await closeWorkQueue({key: 'review-closed', queue: 'review'});
return await parallel([
  () => consumeWork({key: 'developers', queue: 'implementation', maxConcurrent: 2,
    members: args.developers, prompt: 'Implement and test each claimed change. Save progress.'}),
  () => consumeWork({key: 'reviewers', queue: 'review', maxConcurrent: 1,
    members: args.reviewers, prompt: 'Read the prerequisite result with work_status, then independently verify the change.'}),
]);
```

Queue closure is per name. `workStatus({queue:'review'})` selects one queue; omitting `queue` returns the aggregate ledger. Chat accepts `/workflow close review` and `/workflow enqueue` with the new fields. Limits (256 work items, 512 claims, 2 MB queue state, root task/concurrency budgets) are shared, not multiplied per queue. There are at most 16 queues including `default`, 16 pools and 32 distinct members; each pool has 1–16 members. Pool bindings remain immutable on replay, and pool members cannot also receive ordinary script-driven `agent()` or mailbox turns.

## Durable event selection

```js
const event = await waitFor({key: 'evidence-or-deadline', any: [
  {kind: 'message', member: 'reviewer', topic: 'evidence', correlationId: 'issue-7'},
  {kind: 'work', itemId: args.experimentItemId},
  {kind: 'timer', afterMs: 60_000},
]});
```

`waitFor` accepts 1–16 selectors and returns `{index, kind, value}`:

| Selector | Value |
|---|---|
| `message` | A stable batch of `{id, from, text, topic?, correlationId?}` |
| `work` | `{itemId, key, status, generation, result?, error?}` at completion, failure or cancellation |
| `task` | `{taskId, status, error?}` for a terminal managed task; retrieve its output with `joinTask` |
| `timer` | `{at}` containing the saved absolute deadline |
| `quiet` | `{members}`: every member listed in `{kind: "quiet", members: [names]}` is parked in an unsettled wait or receive, has no turn running, and has nothing that wait could receive. A member whose turn failed counts as parked. Every wait watching the same group settles in the same commit. Use it to tell that a group of members coordinating through messages has nothing left to do; [`swarm`](workflows.md#message-board-and-swarms) members are scheduled by the bridge and cannot be waited on this way |

The earliest ready event wins; declaration order breaks timestamp ties. Timers retain their original absolute deadline across replay, so a message arriving after an expired timer cannot win merely because the scheduler has not ticked yet. Timer delivery uses the existing scheduler (normally a 500 ms tick), rather than occupying a worker or promising sub-millisecond timing. The root deadline still bounds every wait.

Only the selected mailbox arm reserves messages. Other messages stay available; the winning batch is acknowledged only after its member's next successful turn. Each message member must already exist and have finished its preceding turn. While selection is pending, those members cannot start a conflicting turn or receive. At selection, losing bindings are released. A pending wait holds no worker process, although its bounded script interpreter remains active.

Results and selector fingerprints persist in the workflow record. Replaying a key with changed selectors or member history is rejected; replaying the original completed wait returns its original selection. A work event is a snapshot, so explicitly retrying the item afterward does not rewrite an already-observed event. Use a new wait key for a later observation.

Convenience calls:

```js
await send('reviewer', 'Reproduction is ready', {
  key: 'deliver-evidence', topic: 'evidence', correlationId: 'issue-7',
});
const messages = await receive('reviewer', {
  key: 'receive-evidence', topic: 'evidence', correlationId: 'issue-7', timeoutMs: 60_000,
}); // [] on timeout; the next successful member turn acknowledges a received batch
const item = await waitWork(args.itemId, {key: 'item-completed'});
await sleep(1000, {key: 'retry-delay'});
```

Untimed `receive` still uses the original mailbox receipt protocol, with optional `topic`/`correlationId` filtering. Workers and main can attach those same fields to `send_message`. `read_context` and received batches include them. Event selection and cancellation each use stable keys in the existing per-workflow namespace. There are at most 128 saved waits and 128 saved cancellation operations, and the VM allows at most 128 control calls per script run. Pending message selections reserve receipt capacity but never reserve losing messages.

## Task handles and cancellation

`startAgent(prompt, options)` accepts the same execution and output settings as `agent()`, except `member`. It creates an independent task and returns `{taskId, output}` as soon as scheduling is committed. Each start counts against the existing worker/task budgets. Handles are valid only after the corresponding start call has been replayed in the current script; a foreign or historical, unreconstructed handle is rejected.

```js
const tasks = await parallel([
  () => startAgent(args.approachA, {key: 'approach-a', output: 'json'}),
  () => startAgent(args.approachB, {key: 'approach-b', output: 'json'}),
]);
return await raceTasks(tasks, {key: 'first-result'});
```

`joinTask(handle)` returns the text or parsed JSON output and rejects on failure/cancellation. `cancelTask(handle,{key})` records cancellation intent, propagates it to that task's child workflow tree, and waits until active workers in that branch exit. Already terminal tasks are left intact. A late answer from a cancelled attempt cannot replace the cancellation outcome. The script cannot return with started tasks still active; await their results or cancellation first.

`raceTasks` accepts 1–16 handles and returns `{index,value}`. It selects the first **terminal** task, cancels the others, waits for their cleanup and joins the selected task. Tasks already terminal when the wait is registered tie by input order, like `Promise.race` over settled promises. A selected failure rejects; it is not a first-success or automatic quality-voting primitive. For quorum or evidence thresholds, explicitly loop over `waitFor` task events, inspect outputs, then cancel unneeded handles.

Managed task handles retain terminal success, failure and explicit script cancellation across replay, preserving earlier branch decisions without launching the same terminal work again. A retry of a terminal failed handle needs a new start key. Pauses/restarts that interrupt unfinished work retain its task/native-session identity and allow explicit replay. Cancellation intent saved before a controller interruption remains authoritative on recovery. Ordinary `agent()` calls keep their existing failure/retry behavior. File/network effects are still outside the workflow transaction and require their existing ownership/idempotency handling.

## Design references and boundaries

The implementation was informed by public material retrieved on 2026-11-02:

- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams): shared work lists, explicit claims, dependencies and direct mailbox communication. We keep those concepts while retaining this bridge's SQLite single-writer state, lease generations and explicit replay. Public documentation describes behavior; this does not claim knowledge of proprietary internals.
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents): distinct execution contexts, explicit lifecycle management and tool capabilities. Persistent members and independent task handles remain distinct here.
- [Temporal TypeScript cancellation scopes](https://github.com/temporalio/sdk-typescript/blob/main/packages/workflow/src/cancellation-scope.ts): cancellation propagates to owned operations and callers wait for termination. This bridge implements task-tree cancellation and durable event choices, not Temporal's full scope, timer or activity system.

The existing `/workflow start` and `/workflow script` authorization boundary is unchanged. These additions do not automatically create teams, start workflows from ordinary messages, grant extra worker permissions, introduce cross-workflow mailboxes, or automatically resume workflows after a restart. Queue routing and resource claims are scheduling controls, not a filesystem sandbox.
