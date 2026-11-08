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

## Speculate past a long gate

Some checks take hours, such as a full model-checking run or a long test suite, while the next step only depends on the check passing. Waiting serially leaves the downstream worker idle; skipping the check accepts unverified work.

```js
return await speculativeAgent(args.implementTask, {
  key: 'impl',
  gate: { prompt: 'Run spec/run.sh on the current spec and report every case result.' },
  worker: args.implementer,
  repair: { prompt: 'Repair the spec for the reported counterexample.', member: 'spec/author' },
  maxRounds: 3,
});
```

`speculativeAgent(prompt,{key,gate,worker?,repair?,maxRounds?,onError?})` starts the gate and the work at the same time. It returns `{value,gate,rounds}` only when the gate of the same round passes, so the returned work was built on a premise that was actually checked. Otherwise it resolves to `null` and logs the reason; with `onError:"throw"` it rejects instead.

- `gate` needs a `prompt` describing the premise and the checks to run, and accepts `harness`, `model`, `reasoningEffort` and `workflowTool`. Each round's gate is an independent task with a fresh context and returns the review contract `{ok:boolean,reason:string,evidence:string[]}`; passing requires evidence. Malformed decisions and gate execution failures fail the helper; they never count as passing.
- `worker` accepts the same options as in `reviewedAgent` and uses the persistent member `<key>/worker` unless one is supplied. Its prompt states that the work is speculative and must stay local and reversible: no publishing, pushing, merging or external messages before the gate passes.
- `repair` needs a `prompt` and accepts `member`, `harness`, `model`, `reasoningEffort` and `workflowTool`. When a gate rejects the premise, the repair runs in persistent member `<key>/repairer` (or `member`, which must differ from the worker's) with the gate report as an input artifact. It runs while the worker's current turn is still going; that turn cannot be cancelled, so it finishes on the old premise. The next round then checks the repaired premise with a new gate and sends the worker a rework turn that references the gate report and the repair, with only a short summary inlined.
- `maxRounds` ranges from 1 to 4. It defaults to 2 with `repair` and 1 without; more than one round needs `repair`. A round uses one gate task and one worker call, plus one repair call before the next round.
- If the worker fails, the helper cancels a gate that is still running instead of waiting for its verdict.

Keys are `<key>/gate/<round>`, `<key>/work/<round>`, `<key>/repair/<round>` and `<key>/cancel/<round>`; reserve those prefixes for the helper. Every started call is settled before a round ends, including on failure. Completed calls are reused on replay. A cancelled gate stays cancelled on replay, so retry after a worker failure with a new key.

The helper only gates its returned value; it does not sandbox the worker. Keep speculative changes in a separate workspace or otherwise reversible, and publish or integrate only after the helper returns. Speculation trades compute for latency: when the gate fails, the speculative turn's work on the old premise is partly wasted. Use it when the gate is slow and usually passes, for example after quick checks already pass. Example: [speculative implementation](../workflow-definitions/scripted/examples/speculative-implementation.js).

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
