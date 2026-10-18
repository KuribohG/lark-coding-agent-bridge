# Unified work-item sources

The bridge uses a shared work-item engine for Lark conversation checks and GitLab CI investigations. Source collection and attention rules remain independent; persistence, human controls, analysis scheduling, execution and delivery share one lifecycle.

Both existing sources can now be configured in a shared [monitor TOML file](monitor-config.md). This configuration layer selects settings; durable observations and lifecycle state remain in the work-item engine.

This is an internal TypeScript integration API. It does not enable 3FS/Yinghuo monitoring or load arbitrary plugins from configuration. Those sources can be implemented against these contracts later.

## Contracts

`src/work-items/contracts.ts` defines:

| Contract | Responsibilities | Existing implementation |
| --- | --- | --- |
| `SourceAdapter` | Scope checks, initialization, invalidation, collection, context refresh, source-specific preflight | `LarkSource`; `EventSource` for GitLab's durable collector |
| `AssessmentPolicy` | Decide whether an observation needs attention | Lark batch/model screening; GitLab deterministic failure rule |
| `InvestigationDriver` | Prepare evidence and prompt; optionally archive a validated result | `larkInvestigationDriver`; `ciTaskDriver` |

`WorkItemService` owns serialized changes, user control, screening dispatch, analysis and notification state. `WorkItemStore` preserves the existing partition paths and schema-1 records. `AnalysisScheduler` preserves the existing single shared FIFO slot. `createInvestigator` runs the same prepare/execute/complete sequence for both existing sources, checking cancellation before each phase.

Source collection continues while analysis waits or runs. Lark collection, history refresh and model screening retain their independent in-flight guards. GitLab retains its repository cursor, bounded polling and failure identity logic, and publishes accepted failures through the event adapter. Neither source implements its own analysis queue.

The source context provides serialized transactions over its partition. A collector must save accepted observations before advancing its cursor. Collection errors are retried as errors and must not be converted into a successful empty query.

## Identity and versions

A work item is the persistent matter being handled. Observations add evidence; an analysis uses one evidence version. `origin` records source and stable key, `evidenceVersion` tracks accepted evidence, and `analyzedVersion` records the basis of the retained report.

For event sources, item IDs keep the existing hash of `[source, owner, executorProfile, key]`. Lark retains existing UUIDs and conversation grouping. Existing CI failure keys still distinguish pipeline and failed-job sets; this change does not combine distinct CI failures into a new incident model.

`WorkItemEvent` is a complete source snapshot:

```ts
await source.observe({
  key: 'stable-source-issue-key',
  eventId: 'source-update-2',
  revision: 2,
  operation: 'upsert',
  title: 'Issue title',
  reason: 'New evidence needs investigation',
  time: Date.now(),
  url: 'https://example.test/issue',
  data: { /* source-validated evidence */ },
});
```

- Revisions are positive, monotonically increasing integers **within one source/item key**. Supply `eventId` whenever supplying a revision. They are independent of `WorkItem.revision`, which protects human edits.
- Replaying the same revision and snapshot is idempotent, including reordered JSON object fields; older revisions are ignored. A conflicting snapshot at the same revision is rejected. Collectors must retain stable event data, including timestamps, during retries.
- `operation: 'resolve'` records source recovery and suppresses obsolete automatic work. An initial resolve is accepted without running a model. A subsequent upsert can reopen the source state, subject to human controls.
- Omitting version fields preserves the old create-only `submit` behavior. Re-submitting the same key does not change the existing item. Existing GitLab collectors retain this behavior.
- `initial` imports an already-known outcome only when an item does not exist. It never overwrites an existing draft or delivery receipt.
- Update persistence happens before cancelling an obsolete investigation or acknowledging acceptance. A failed save rolls back the in-memory update, allowing replay.

Versioned event updates cancel an obsolete investigation and queue the current version. The old result cannot overwrite the replacement state. Lark preserves its existing incremental behavior: messages arriving during analysis remain attached; the current report is retained with its input version and then screened against the additional messages.

## Independent states

`businessState` describes whether the source issue is open or resolved. `state` describes investigation/delivery progress. `handlingState` describes the user's handling decision. Analysis completion does not resolve a source issue; ignoring a matter does not mark it recovered.

Updates preserve edited drafts, existing analysis topics and explicit pause controls. A stopped analysis cannot be reactivated by source updates or process restart. Only an explicit process request clears its pause. Source-verified preflight may return a cached result with `businessState: 'resolved'`, as GitLab does when a failure has become obsolete; the model cannot set this field through its output.

The existing report format (`replyDraft`, `analysis`, `missingInfo`) remains supported and required by the shared result validator. Source-specific input stays in its evidence payload; external items have no fabricated chat messages.

## Registration

`WorkItemSources.connect()` registers an event source under a source/owner/profile partition. It accepts an optional `SourceAdapter`, optional deterministic assessment, the investigation driver, execution settings and notification configuration. Existing `InboxTaskSources` and `InboxTaskDriver` imports remain compatibility aliases.

The Lark manager passes `larkRuntime()` into the same `WorkItemService` through the `InboxService` compatibility facade. Lark source logic lives in `src/inbox/source.ts`, model-decision application in `src/inbox/assessment.ts`, and evidence preparation in `larkInvestigationDriver`. Lark-only commands such as selecting a chat or changing intake scope remain on the facade.

GitLab registers `EventSource` with `ciAssessment` and `ciTaskDriver`. Its collector still validates pipeline and job status and supplies a stable failure identity; the common engine owns all subsequent handling.

Keep source-specific operations out of the shared engine. New collectors should define their own task/run mapping and recovery evidence, then submit observations; they should not manufacture Lark messages or instantiate another analysis loop.

## Migration and limits

Loading existing records fills missing origin/version fields and removes synthetic messages from external events. It preserves item IDs, results, manually edited drafts, pause flags, topics, attempts and delivery receipts. Inbox and source state directories are unchanged, and the UI continues to receive its existing fields. Conversation display fields remain in the persisted compatibility representation; new event producers do not need to supply them.

An interrupted investigation still requires an explicit retry, matching the existing behavior. This refactor does not enable automatic recovery of interrupted monitoring investigations, priority/reserved execution slots, cross-source incident correlation, or new monitors. Those require separate source and scheduler policies.

Tests cover existing Lark/CI behavior plus migration, observation replay/order conflicts, save failure rollback, late results, source recovery, manual controls, owner isolation and cancellation between investigation phases. Model and Lark writes are mocked in these tests; they do not establish live operational monitoring.
