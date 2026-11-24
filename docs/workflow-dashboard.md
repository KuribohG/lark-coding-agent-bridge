# Workflow dashboard

[Documentation index](README.md) · [Workflows](workflows.md) · [Embedding the workflow engine](../packages/workflow-engine/README.md)

A read-only web page for watching workflows: every workflow of a bridge home, and for each one its goal and the leads' status notes, to-dos and open asks, work queues, members, work items, the board, turns with their prompts and results, the plan, and the latest journal events. It is meant for the runs that outgrow a chat card: a swarm of a hundred members is a table, not a message.

```sh
lark-channel-bridge dashboard                # every profile of this bridge home that has a workflow store
lark-channel-bridge dashboard --profiles codex --port 8790 --label "$(hostname)"
```

The command prints an address that carries a token; open it in a browser on the same machine. It keeps serving until it is stopped. It needs no running bridge and no Lark, Slack or agent credentials.

## Where it sits

Lark, Slack and browser chat are *channels*: each carries conversations, and a workflow belongs to the conversation that started it. `/workflow status` and the progress card answer in that conversation, in text. The dashboard is not a fourth channel. It is a second *presentation* of the same workflows, across all conversations and profiles at once, and it reads them from the place every channel's workflows end up in: the journal.

```text
Lark ──┐
Slack ─┼─ channel ─ WorkflowHost ─ WorkflowRuntime ──writes──▶ workflows.sqlite (journal)
Web ───┘     ▲                        (one per profile)                │
             │ /workflow … (chat/commands.ts, text)                    │ read-only, followed
             │                                                         ▼
             └──────── people act here ◀─────── people watch here: dashboard/ (views → JSON API → page)
```

| Layer | Where | What it is |
| --- | --- | --- |
| Views | `packages/workflow-engine/src/dashboard/views.ts` | Pure projections of `WorkflowState` into JSON for people: names instead of IDs, counts that include what was archived, long texts cut. No database, no clock other than timestamps. A host may call them on `runtime.kernel.state()` as well. |
| Journal reader | `dashboard/journal.ts`, `WorkflowStore.follow()` | Opens a store read-only beside the process that owns it and replays what that process commits. |
| API | `dashboard/api.ts` | `DashboardApi.handle(path, query, ifNoneMatch)`: the read-only JSON API apart from any transport, with an ETag per workflow position. |
| Server and page | `dashboard/server.ts`, `dashboard/page.html` | `startDashboard()`: Node's `http`, one self-contained page, no build step and no dependencies. The page shows the plan formatted from its Markdown, with a small parser of its own that yields text only, so a plan cannot inject markup. |
| Commands | `agent-workflow dashboard --db …`, `lark-channel-bridge dashboard` | The engine's own CLI takes store files; the bridge's finds the profiles' stores. |

Reading the journal instead of asking the running bridge is deliberate:

- **The bridge is not touched.** Polling a large swarm's state from inside the bridge would copy megabytes on the event loop that schedules its workers. The dashboard is another process with its own copy.
- **It outlives the bridge.** It keeps working through a restart or an upgrade of the bridge, shows workflows of a bridge that is down, and can be pointed at a copy of a store for a post-mortem.
- **It cannot change anything.** The store is opened read-only and the server answers `GET` only. Pausing, resuming, cancelling, posting and changing the goal stay with `/workflow` in the conversation, where the bridge checks who is asking.

The price is that the dashboard replays the journal with the reducer of *its own* build. Run it from the same release as the bridge. A workflow whose journal holds an event this build does not know is listed as unreadable, with the reason; the others are unaffected.

## Behind a proxy

The page requests everything relative to its own address, so it works under any path prefix. `--state-file` (default `<home>/workflow-dashboard.json`, mode 0600, removed on exit) records the address, the token and the process, so that a local proxy can add the token (`x-workflow-dashboard-token`) and a browser never sees it. With `--no-token` the API is served without one; use that only for a listener that nothing but an authenticating proxy can reach.

The dashboard shows prompts, results and messages of every workflow in its stores. It listens on `127.0.0.1` unless `--host` says otherwise; treat a wider listener like access to the workspace.

A page that cannot reach the API over HTTP at all may define `window.__wfTransport(path, etag)` before the page script runs; it resolves to `{ status, etag, body }`.

## API

All under `/api`, `GET` only, JSON. `:source` is a profile name, `:id` a workflow ID.

| Path | Answer |
| --- | --- |
| `/sources` | The stores and their journal positions |
| `/s/:source/workflows?finished=50` | Unfinished workflows, then the latest finished roots, each with a summary |
| `/s/:source/w/:id/overview` | Summary, goal, status notes, script, swarms, queues, to-dos, asks, notices, the workflow tree |
| `/s/:source/w/:id/members`, `/member?name=` | Members and one member in detail |
| `/s/:source/w/:id/work?queue=&status=&q=&archived=1&offset=&limit=`, `/item?key=` | Work items and one item with its input, result and claims |
| `/s/:source/w/:id/board?topic=&member=&q=&before=&limit=` | Posts, newest first, continuing into the archive |
| `/s/:source/w/:id/turns?show=active\|failed\|all&member=`, `/turn?task=` | Turns and one turn with its prompt, attempts and result |
| `/s/:source/w/:id/plan`, `/journal?before=&limit=` | The plan and script source; the latest journal entries |

Answers carry an `ETag`; a request with `If-None-Match` is answered `304` while the workflow has not changed, which is what the page's 2.5 s polling relies on. Lease renewals are not journal events, so a claim's lease is shown as of the workflow's last change.

## Limits

- Read-only, as above.
- A conversation is shown by its scope ID; the dashboard does not know chat or thread names.
- Finished workflows are deleted with their journal after the retention period (`WORKFLOW_JOURNAL_RETENTION_DAYS`, 30 by default), and the journal tab only has the events the latest snapshot does not cover.
- The page is in Chinese, like the workflow command texts.
