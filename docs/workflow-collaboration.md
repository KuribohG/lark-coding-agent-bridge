# Feedback and independent verification

Use collaboration where it can catch mistakes or shorten the path to a valid result. Independent subtasks can still use ordinary `parallel`; small tasks do not need a review loop. This page describes two opt-in additions inspired by public Claude Code behavior, with the bridge's existing budgets and replay rules.

## Feedback wakes queue consumers

```js
await consumeWork({
  key: 'investigators', queue: 'investigation', members: args.investigators,
  prompt: 'Investigate the assigned hypotheses. Challenge unsupported conclusions with concrete evidence.',
  wakeOnMessages: true,
});
```

With `wakeOnMessages:true`, messages to an already-created pool member are delivered automatically in its next turn. An idle member can handle feedback while other members are still working, even when there is no claimable work. A busy member finishes its current turn first; feedback never creates two simultaneous turns for the same member. This does not inject messages into an in-progress native request.

The turn receives the same stable inbox batches as ordinary `receive()`, including `topic` and `correlationId`. It acknowledges them only on successful completion. Failure/interruption preserves the input batch for explicit replay. New messages arriving during that turn wait for a later turn. A message-only turn does not reserve work that another idle consumer could claim.

Pool bindings, including this option, remain immutable on replay. The default is false, preserving existing scripts. Members are still created lazily by initial work; sending to an unknown member is rejected. Ordinary `agent()`/`receive()` cannot independently schedule a pool member.

Close the queue after all feedback producers have finished. Before draining, an opted-in pool handles messages already pending, as well as its work. A drained pool is terminal: messages sent after drain do not restart it. Feedback turns use the same concurrency, task, attempt, receipt and deadline budgets; they cannot extend the workflow indefinitely. Send useful evidence or a concrete request rather than acknowledgement-only replies.

Feedback does not reopen a completed work item or grant ownership of files. If a correction needs writes, arrange a new work claim with the appropriate resource keys. For a task whose result must not be accepted until verification, use the helper below before returning its result.

## Independently verify before accepting a result

```js
return await reviewedAgent(args.task, {
  key: 'parser-change',
  criteria: 'The empty-input regression passes. Existing supported syntax is preserved. Include commands and artifact paths.',
  worker: args.implementer,
  reviewer: args.verifier,
  maxRounds: 2,
});
```

`reviewedAgent(prompt,{key,criteria,worker?,reviewer?,maxRounds?,onError?})` returns `{value,review,rounds}` only after the independent reviewer accepts the candidate. Otherwise it resolves to `null` and logs the reason; with `onError:"throw"` it rejects instead. Without a workspace it composes ordinary authorized `agent()` calls. With `worker.workspace`, it adds fixed-snapshot review and returns `{change,approval}` as well; see [worktree integration](workflow-worktrees.md).

- `key` is stable, unique and 1–80 characters, without surrounding whitespace or an `@` prefix.
- `criteria` is a nonempty string of at most 16000 characters. Describe observable acceptance tests, not just "looks good".
- `worker` accepts `harness`, `model`, `reasoningEffort`, `workflowTool`, `member`, `output`, `schema` and `workspace`. It uses the persistent member `<key>/worker` unless one is supplied. A rejection goes back to that same member with a short summary and the full review as an input artifact reference, so long evidence lists never inflate the prompt.
- `reviewer` accepts `harness`, `model`, `reasoningEffort` and `workflowTool`. Every review is an independent task with a fresh context; it cannot share the worker's member history. It receives the task and acceptance criteria inline and the candidate as an input artifact reference, and is instructed to inspect evidence and perform relevant checks. Its output must match the review contract's JSON Schema; the bridge restates mismatches in the same session before failing.
- The review contract is `{ok:boolean,reason:string,evidence:string[]}`. The reason must be nonempty and evidence entries must be nonempty strings; there is no count or length limit beyond the overall agent output size. Approval requires at least one evidence entry. Malformed decisions and reviewer execution errors fail the helper (`null`, or a rejection with `onError:"throw"`); they never count as approval.
- `maxRounds` defaults to 2 and ranges from 1 to 4. Each round uses one worker call and one review call. Exhausting the bound fails the helper with the rejection reason. All calls still consume the original workflow budgets.

Keys are `<key>/work/<round>` and `<key>/review/<round>`; reserve those prefixes for the helper. Successful calls and the recorded review decision are reused on replay without new native work. Replay retains the existing `agent()` retry rules and member history constraints. Include external-state revisions in task inputs or use new keys when fresh validation is required.

The helper gates its returned value. It does not intercept arbitrary `complete_work` calls, install Claude hooks, or enforce a filesystem sandbox for the reviewer. Do not let the implementation task publish/merge or mark unrelated queue work accepted before this review finishes. A model's approval remains a judgment; requiring evidence improves the contract but does not prove that the evidence is true. Preserve the underlying test output and use appropriate deterministic checks for the task.

Independent tasks can each use this helper inside `parallel`. Give concurrent workers separate file ownership or work claims. Apply review to work where mistakes matter; unnecessary review adds latency. Example: [reviewed implementation](../workflow-definitions/scripted/examples/reviewed-implementation.js).

## Public design references

Material checked on 2026-11-02:

| Claude Code public behavior | Bridge relationship |
| --- | --- |
| [Shared tasks, dependencies and claims](https://code.claude.com/docs/en/agent-teams#assign-and-claim-tasks) | Already provided by work queues, dependencies and leases |
| [Automatic teammate messaging](https://code.claude.com/docs/en/agent-teams#context-and-communication) | Opt-in pool feedback now starts a subsequent member turn; active-request injection is not implemented |
| [TaskCompleted](https://code.claude.com/docs/en/hooks#taskcompleted) / [TeammateIdle](https://code.claude.com/docs/en/hooks#teammateidle) blocking with feedback | The review helper provides an acceptance/rework loop; it is not an implementation of those hook events |
| [Agent-based hooks](https://code.claude.com/docs/en/hooks#agent-based-hooks) inspect evidence and return a decision | Independent reviewer calls use existing authorized workers; they are not Claude's agent-hook subprocesses |
| [Competing hypotheses](https://code.claude.com/docs/en/agent-teams#investigate-with-competing-hypotheses) | A recommended task/prompt pattern using independent workers and targeted feedback, not an automatic voting guarantee |
| [Subagent worktree isolation](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields) | Opt-in managed worktrees now provide isolated checkouts and retained modified work; snapshot approval and checked integration are bridge-specific extensions |

The checked documentation does not establish generic `firstSuccess`, quorum, producer backpressure or Temporal-style cancellation scopes as Claude Code APIs. Those remain separate design proposals. Plan mode/approval exists, but current documentation describes automatic approval for some teammate spawn paths, so it must not be equated with mandatory independent plan review. No measured correctness or speed improvement is claimed without a representative comparison.
