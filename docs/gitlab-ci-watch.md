# GitLab CI failure analysis

The bridge can poll a configurable list of GitLab projects and investigate failed
pipelines with `deepseek-flash`. It uses the executor profile's normal Codex
runtime, tools and rules, with `max` reasoning effort. The investigation prompt
permits reading source and downloading evidence, and prohibits modifying a repo,
retrying CI, pushing, merging, deploying or sending messages. These are agent task
instructions, not a separate permission sandbox.

Save a JSON settings file and load it with:

```sh
lark-channel-bridge ci-watch configure /absolute/path/ci-watch.json
lark-channel-bridge ci-watch status
```

Both commands accept `--config /absolute/path/to/bridge/config.json`. Settings live
in the root config's `gitlabCi` field and survive other profile configuration
changes. A bridge version with this feature reloads settings within 15 seconds;
the selected executor profile must be online. The status command reports persisted
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
A retried job with a new failed job ID can trigger another analysis. One analysis
runs at a time while polling continues. Analysis failures retry at most three
attempts, including attempts interrupted by a bridge restart. Finished results
are reused after a restart. Deduplication records are kept for 30 days; evidence
and results remain in `outputDir/<run-id>/` until the owner removes them.

The run directory contains `evidence.json`, raw `job-<id>.log` files and a
structured `result.json`. Trace downloads are capped at 32 MiB per job and explicitly
mark truncation. Missing/erased logs are reported as evidence gaps. State and queue
records live beside bridge configuration in `gitlab-ci/state.json`. Stop the
executor profile or set `enabled: false` to stop polling and abort active work.

Without `notification`, results stay local. To have the bridge announce and deliver
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
locally. The destination should be a dedicated results group, such as the existing
inbox results group, so human follow-up does not create unrelated inbox work.
