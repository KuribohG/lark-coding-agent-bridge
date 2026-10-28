# Unified work-item sources

The bridge uses a shared work-item engine for Lark conversation checks, GitLab CI investigations and storage/UID incidents. Source collection and attention rules remain independent; persistence, human controls, analysis scheduling, execution and delivery share one lifecycle.

All built-in sources can be configured in a shared [monitor TOML file](monitor-config.md). This configuration layer selects settings; durable observations and lifecycle state remain in the work-item engine.

This is an internal TypeScript integration API with statically registered plugins and source modules. It does not load arbitrary code from configuration. Storage and UID monitoring is described in [storage-monitoring.md](storage-monitoring.md); configuring a source does not deploy or activate a newer Bridge binary.

## Source modules and dependency boundaries

Each monitoring method has one directory under `src/monitoring/sources/`:

```text
src/monitoring/
  module.ts          # Config registration and runtime lifecycle contracts
  config.ts          # TOML envelope; delegates each section to its module
  store.ts           # Shared config persistence and conflict checks
  runtime.ts         # Shared engine ownership and module lifecycle
  notification.ts    # Common delivery settings, independent of source rules
  sources/
    configs.ts       # Static configuration registrations; no runtime imports
    index.ts         # Static runtime factories
    lark/            # Collection, model screening, tools, investigation, manager
    gitlab-ci/       # GitLab client, polling, failure rules, investigation, manager
    storage/         # Grafana provider, cluster/UID rules, investigation, manager
src/work-items/      # Persistence, versioning, scheduling, analysis, controls
src/inbox/           # Lark transport/workbench adapter and hosted UI
```

A module exposes a config registration (`id`, legacy root field, parser, optional
reference validation and status summary) and a runtime factory. `MonitorContext`
provides the config path, the shared `WorkItemSources` and a `MonitorHost`. The host
supplies an `ExecutionProvider` and a factory for source execution/delivery adapters.
The factory constructs a controller; constructors must not start I/O. Controllers
implement `reconcile()` and `close()`, own their collector timers/leases, and retain
last-valid-config and cancellation behavior. `MonitorRuntime` reconciles them
independently, closes them in reverse registration order, then closes the shared
engine. A module never closes an engine supplied by the host.

GitLab and storage do not import Lark collection or screening. Their notification
configuration uses the shared delivery contract. The common event registry creates
`WorkItemService` directly; it does not create a Lark source facade. Source-specific
screening error descriptions are provided through `AssessmentPolicy.failureReason`.
The existing shared workbench and Lark delivery transport are still reused.

To add a built-in source:

1. Add `sources/<name>/` with its configuration, collector/provider, investigation
   driver and controller. Publish versioned observations through `WorkItemSources`;
   do not create another analysis queue or notification retry loop.
2. Register its config in `sources/configs.ts` and its factory in `sources/index.ts`.
   A new typed root setting also needs its field in `RootConfig`/`MonitorSettings`.
   Keep config registration imports free of managers, credentials and network I/O,
   so CLI validation remains local and side-effect free.
3. Reuse shared work-item, notification and validation contracts. Avoid importing
   another source's implementation. Add source-specific tests and a disabled TOML
   example; lifecycle and generic TOML parsing do not need new source branches.

Lark, GitLab CI and storage source IDs remain unchanged. Each source now persists
its generic work-item state as `state.sqlite` beside the former `state.json`.
The SQLite transaction stores jobs, cursors, dedupe keys, budgets and the
notification outbox together. A version-2 legacy JSON file is imported once and
archived; an unsupported version-1 conversation-shaped file is archived without
being overwritten.

## Host and executor lifecycle

`src/plugins/work-items/runtime.ts` assembles the bridge's monitor modules. GitLab and storage
receive the source-neutral `MonitorHost`; Lark intake receives a separate, narrow
`LarkMonitorProfiles` capability for its app, identity and channel configuration.
No monitor or work-item contract imports chat command `Controls`.

`ProfileExecutionProvider` resolves background execution from the persisted
profile and local agent availability. It does not require that profile's chat
channel to be online. The bridge host still explicitly supplies the existing
Lark-aware agent environment for tool compatibility. Other hosts can inject an
executor and delivery runtime directly without constructing a Lark client.
Profiles remain in the existing on-disk schema. Work items use transport-neutral
owner, source and target fields; chat-specific identifiers are confined to source
adapters. This change does not add a standalone worker command.

In a build containing this host/executor separation, disabling a Lark profile
leaves enabled GitLab/storage collectors running. Unavailable or unsupported
executors leave new investigations durably queued without spending analysis
attempts or automatic quota. Readiness is refreshed during monitor reconciliation;
available execution resumes eligible work while manual pauses remain authoritative.
Execution-policy replacement or revocation cancels the old executor's work without
stopping source collection. Source `enabled: false` and supervisor shutdown still
stop collectors and close their work-item services. Older builds retain the
profile-online prerequisite; deploy the new build before relying on this behavior.

Delivery remains independent: a configured Lark transport retains the existing
bounded retries and confirmation rules when unavailable. A host with no result
transport retains completed reports locally without recording a delivery receipt.
The shared per-kind execution pools, notification-before-analysis policy for CI/Lark, storage's
independent source notices and restart-retry rules are preserved.

## Contracts

`src/work-items/contracts.ts` defines:

| Contract | Responsibilities | Existing implementation |
| --- | --- | --- |
| `SourceAdapter` | Scope checks, initialization, invalidation, collection, context refresh, source-specific preflight | `LarkSource`; `EventSource` for GitLab's durable collector |
| `AssessmentPolicy` | Decide whether an observation needs attention | Lark per-item model screening; GitLab deterministic failure rule |
| `InvestigationDriver` | Prepare evidence and prompt; optionally archive a validated result | `larkInvestigationDriver`; `ciTaskDriver` |

`WorkItemService` owns serialized changes, user control, screening dispatch, analysis and notification state. `WorkItemStore` preserves the existing partition paths and schema-2 records. In versions supporting per-item screening, `WorkItemScheduler` supplies the same FIFO/resize/cancellation implementation to two independent pools: `[concurrency].triage` defaults to fifty individual screening tasks; `analysis` defaults to five investigations shared by Lark, CI and storage. A common admission loop fills each pool up to its own limit. `ItemAssessmentPolicy` evaluates one item and returns one decision; no batch assembly, size selection or partial-result tracking is required. Both task maps key cancellation and ownership by item ID. Live resizing drains existing tasks when lowering the limit. An aborted task keeps its slot and item reservation until it settles, preventing overlapping retries. Completion immediately requests dispatch, independently of collection. Screening can finish and enqueue investigation while other items are still screening. `createInvestigator` runs the same prepare/execute/complete sequence for existing sources, checking cancellation before each phase.

Source collection continues while analysis waits or runs. Lark collection, history refresh and model screening retain their independent in-flight guards. GitLab retains its repository cursor, bounded polling and failure identity logic, and publishes accepted failures through the event adapter. Neither source implements its own analysis queue.

The source context exposes items with read-only lifecycle fields, source-owned evidence,
cursors and deduplication records. It does not expose the mutable work-item store or
notification outbox. Source mutations run in serialized transactions: `create` registers
conversation evidence, and `transition` applies a typed event such as new evidence,
manual processing, owner handling, recovery, scope change or feedback exclusion.
`WorkItemLifecycle` owns the resulting analysis, handling, pause and retry rules.
A collector saves accepted evidence and its cursor together. Collection errors are
retried as errors and must not be converted into a successful empty query.

Per-item screening returns an interpreted decision instead of editing a live item.
Analysis preflight can add evidence through the same context; the completion hook
returns the evidence basis and whether additions need review. The engine applies
both results after checking the active attempt and evidence/review versions.
`WorkItemDelivery` owns start announcements, source notices, results and attention
digests; source adapters cannot modify their reservations or receipts.

## Identity and versions

A work item is the persistent matter being handled. `ownerKey`, `sourceRef` and
`target` are transport-neutral keys. Observations add transport-neutral evidence
messages with `containerId`, `containerKind`, structured principal mentions and
thread/reply references. `origin` records source and stable key, `evidenceVersion`
tracks accepted evidence, and `analyzedVersion` records the basis of the retained report.

For event sources, item IDs use the hash of `[source, ownerKey, executorProfile, key]`.
Lark retains conversation grouping inside its adapter. Existing CI failure keys still
distinguish pipeline and failed-job sets; this change does not combine distinct CI
failures into a new incident model.

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

Updates preserve edited drafts, existing analysis targets and explicit pause controls. A stopped analysis cannot be reactivated by source updates or process restart. Only an explicit process request clears its pause. Source-verified preflight may return a cached result with `businessState: 'resolved'`, as GitLab does when a failure has become obsolete; the model cannot set this field through its output.

The existing report format (`replyDraft`, `analysis`, `missingInfo`) remains supported and required by the shared result validator. Source-specific input stays in its evidence payload; external items have no fabricated chat messages.

## Registration

`WorkItemSources.connect()` registers a source under the existing source/owner/profile
partition. Its internal API accepts `config: WorkItemConfig`, `source: SourceAdapter`,
`runtime: Omit<WorkItemRuntime, 'source'>` and an optional status callback.
The runtime supplies investigation, readiness and optional delivery hooks; the
registry does not construct agents, Lark clients, COT or workbench commands.
`select(ids, scope)` validates source/owner/profile boundaries before returning the
service for a control operation. `executeSourceCommand` in the workbench adapter
owns command decoding and presentation. Existing `InboxTaskSources` and
`InboxTaskDriver` imports remain aliases, with the new internal registration API.

The Lark manager passes `larkRuntime()` into the same `WorkItemService` through the `InboxService` adapter. Lark source logic lives in `src/monitoring/sources/lark/source.ts`, model-decision interpretation in `src/monitoring/sources/lark/assessment.ts`, and evidence preparation in `larkInvestigationDriver`. Lark-only commands such as selecting a container or changing intake scope remain on that adapter.

GitLab registers `EventSource` with `ciAssessment` and `ciTaskDriver`. Its collector still validates pipeline and job status and supplies a stable failure identity; the common engine owns all subsequent handling.

Keep source-specific operations out of the shared engine. New collectors should define their own task/run mapping and recovery evidence, then submit observations; they should not manufacture Lark messages or instantiate another analysis loop.

## Migration and limits

The work-item document schema remains version 2. SQLite storage and its migrations
are versioned independently. A version-1 file used the previous chat-specific
shape and is archived because its fields cannot be mapped safely without inventing
source data. No dual-field or TOML migration is retained. Item state directories
are unchanged. The UI maps the canonical fields to its presentation model.

An interrupted investigation still requires an explicit retry, matching the existing behavior. Lark and GitLab retain explicit retry after interrupted investigations. Storage opts into bounded automatic recovery and a separate incident slot as described below. General cross-source incident correlation is not implemented.

Tests cover existing Lark/CI behavior plus schema migration, observation replay/order
conflicts, save failure rollback, late results, source recovery, manual controls,
owner isolation and cancellation between investigation phases. Model and Lark writes
are mocked in these tests; they do not establish live operational monitoring.

## Storage and UID source

`src/monitoring/sources/storage/` uses the same versioned event/lifecycle contract and,
in versions supporting per-item screening, shares investigation slots with Lark
and GitLab CI. Screening has its own pool. It uses persisted source notices, a daily automatic attempt
limit, and bounded recovery of restart-interrupted analyses. Lark and GitLab retain
their explicit restart-retry semantics.
Source notices run outside the model queue, establish a confirmed topic, and retain
bounded retry receipts. Alert delivery failure does not block storage investigation.
Recovery is issued by the collector after fresh sustained observations, never by the
model. Material updates coalesce while analysis is running; source-confirmed recovery
can cancel stale work. Manual draft edits, stops and handling state remain authoritative.

Result and attention-digest delivery reserve and persist each attempt inside the
state transaction, send an immutable snapshot outside it, then persist the receipt
in another transaction. Collection and human controls continue while a send is
pending; overlapping ticks share the same delivery pass. Shutdown drains outstanding
sends. A result receipt records confirmation without marking newer evidence or an
edited draft as delivered. Existing retry identities, three-attempt bounds and
restart recovery remain in place; an ambiguous network outcome is not an exactly-once
delivery guarantee.
