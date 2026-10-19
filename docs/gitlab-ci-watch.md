# GitLab CI failure analysis

中文操作说明见[用户手册：盯盘与任务来源](user-guide/monitoring.md)。

New versions can keep both CI and Lark settings in a single [monitor TOML file](monitor-config.md). The JSON import command below remains supported and updates that file after migration.

CI is a task source of the conversation assistant. The watcher only polls and
submits durable, idempotent events. The assistant owns analysis scheduling,
retries, drafts, review state, and notifications. The bundled assistant workbench
shows CI and conversation items together; use the source filter to inspect CI.
Chat intake and CI keep independent switches and execution model settings.

The bridge can poll a configurable list of GitLab projects and investigate failed
pipelines using a configured Claude or Codex agent. It uses the executor profile's normal agent
runtime, tools and rules, with `max` reasoning effort. The investigation prompt
permits reading source and downloading evidence, and prohibits modifying a repo,
retrying CI, pushing, merging, deploying or sending messages. These are agent task
instructions, not a separate permission sandbox.

Save a JSON settings file and load it with:

```sh
lark-channel-bridge ci-watch configure /absolute/path/ci-watch.json
lark-channel-bridge ci-watch status
```

Both commands accept `--config /absolute/path/to/bridge/config.toml`. Settings live
in `monitors.toml` when selected by `bridge.monitors_file`, or the root TOML's `monitoring.gitlab_ci` table and survive other profile configuration
changes. A bridge version with this feature reloads settings within 15 seconds;
builds containing the independent background executor resolve its configuration
without requiring the Lark profile to be online. Earlier builds require the
profile online. The supervisor process must keep running in both cases. The status command reports persisted
state, including the last poll time/error; it does not assert process liveness.

Example for 3fs-vnext (replace the local paths and profile name):

```json
{
  "enabled": true,
  "executorProfile": "codex",
  "url": "https://gitlab.deepseek.com",
  "tokenEnv": "GITLAB_TOKEN",
  "credentialsFile": "/absolute/path/.gitlab.env",
  "pollSeconds": 60,
  "model": "deepseek-flash",
  "outputDir": "/absolute/private/path/gitlab-ci-analysis",
  "repositories": [
    {
      "project": "data_platform/3fs-vnext",
      "refs": [],
      "sourceDir": "/absolute/path/3fs-vnext"
    }
  ]
}
```

`project` accepts a numeric ID or namespace/project path. Empty `refs` watches all
refs, including MR pipelines; otherwise entries are exact GitLab ref names.
Versions with one-second CI polling support accept `pollSeconds` from 1 to 3600;
the default remains 60. Earlier versions clamp it to at least 30 seconds and must
be upgraded first. Polls do not overlap: a slow query delays the next completed
check, so this setting is not a guarantee of one-second failure notification.
`sourceDir` is optional context for reading code, not a directory the watcher
checks out or modifies. Add more entries to `repositories` to watch other repos
on the same GitLab server. Tokens come from `tokenEnv`, or from literal
`GITLAB_TOKEN` / `GITLAB_URL` assignments in `credentialsFile`; the file is never
executed as a shell script. A credential URL, when present, must match `url`.
HTTP redirects are refused. Supply the token separately from bridge configuration.

On first activation of a repository, the watcher records the current time before
querying GitLab. It does not backfill older failures. A pipeline already running
at activation is caught when it subsequently fails. Later polls use a persisted
cursor and an overlapping update window, with paginated pipeline/job/bridge reads.
Failures during API reads do not advance that repository's cursor. Removing a
repository stops new work for it; re-adding it resumes its existing cursor.

Only aggregate `failed` pipelines trigger investigation. `manual`, `canceled`,
`skipped`, `running`, and `success` do not trigger it. Allowed-to-fail jobs are
excluded. Failed downstream bridge metadata is included so the agent can inspect
the child pipeline. Pipelines that have failed without an ordinary failed job are
still investigated. Immediately before evidence collection, the watcher rechecks
the pipeline and failure IDs and skips obsolete work.

Each distinct pipeline plus set of current failed job/bridge IDs is deduplicated.
A retried job with a new failed job ID can trigger another analysis. Conversation and source analyses share one FIFO execution slot per Bridge
process while polling continues. Automatic CI analysis failures retry at most
three attempts. Explicit user retries do not automatically repeat on failure.
An analysis interrupted by a Bridge restart requires a manual retry; completed
results are reused. Deduplication records are kept for 30 days; evidence
and results remain in `outputDir/<run-id>/` until the owner removes them.

The run directory contains `evidence.json`, raw `job-<id>.log` files and a
structured `result.json`. Trace downloads are capped at 32 MiB per job and explicitly
mark truncation. Missing/erased logs are reported as evidence gaps. Watcher cursors and submission IDs live beside bridge configuration in
`gitlab-ci/state.json`; assistant tasks live in
`inbox/sources/gitlab-ci/<identity-scope>/state.json`. Set `enabled: false` to stop
polling and abort active work. With the independent background executor, stopping
the Lark profile leaves CI collection running; if the executor is unavailable,
new analyses remain queued. This behavior requires deployment of the refactor.

Without `notification`, results are available in the local assistant workbench
and private run directory, without sending Lark messages. To have the bridge announce and deliver
results as the bot, add an explicitly chosen destination:

```json
{
  "notification": {
    "ownerOpenId": "ou_owner",
    "deliveryMode": "new_topic",
    "destination": {
      "chatId": "oc_result_group",
      "threadId": "omt_existing_setup_topic",
      "replyTo": "om_existing_setup_message"
    }
  }
}
```

`new_topic` creates one topic per failure; `thread` replies to the configured
topic. Destinations are checked using the bot's access before sending. The start
announcement and topic are persisted before launching the agent. Delivery retries
use a stable idempotency key and never rerun a completed model analysis. Delivery
is attempted at most three times; an undelivered `ready` result remains available
locally. The destination can be the existing assistant results group. Events enter
the assistant directly, not by re-reading bot notifications. Chat intake filters
its own output as before.


## Claude executor

A personal Claude profile can be used as `executorProfile` (Claude Code 2.1.302+).
Set `model` to an available Claude model, or to `""` to follow its profile/CLI
default. An omitted model preserves Flash for Codex and uses the profile/CLI default
for Claude. Existing explicit model values remain unchanged when changing the
executor, so clear or replace a previously configured `deepseek-flash` override.
CI retains its max-effort request and the existing model compatibility resolution.

CI analysis runs through the shared background executor and does not require a
separate Responses API screening service. Lark notification identity remains the
configured execution profile. No new monitor is enabled by this adapter change.


## Existing installations

On the first active poll with this version, known legacy runs are imported into
assistant tasks. Completed results are imported without model execution; known
delivered results are not sent again. If an old delivery was attempted but never
confirmed, keep the result in the workbench for review instead of resending with
a new notification key. Missing or interrupted results require manual retry.
Submission is acknowledged only after the assistant store is saved, so a restart
between the two stores cannot create a second task.

Disabling CI stops its polling and active work, preserving history. Pausing the
assistant's Lark message intake does not disable CI. Different owner/profile
combinations use separate state partitions; data is not automatically transferred
when changing identity. The local workbench aggregates registered sources. The
optional hosted workbench syncs source items only for its matching owner and
executor profile; its frontend may need an update to expose source-specific UI.
