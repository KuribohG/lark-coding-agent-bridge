# Unified monitor configuration

Versions containing the monitor-config implementation can keep Lark conversation checks, GitLab CI and storage/UID monitoring in one TOML file. Source behavior, credentials, item state and the unified investigation engine remain separate from the configuration file.

## Existing installations

Run these commands with the new Bridge version and the intended root configuration:

```sh
lark-channel-bridge monitors init --config /path/to/config.toml
lark-channel-bridge monitors check --config /path/to/config.toml
lark-channel-bridge monitors status --config /path/to/config.toml
```

`init` writes `monitors.toml` beside `config.toml`, preserving existing source switches, scope, model omission/default semantics, credential references and notification targets. It sets `bridge.monitors_file` in the root TOML and removes the inline monitoring configuration. Profiles, credentials, polling cursors, items and drafts are not migrated or reset. A missing source gets a disabled starter section. Existing target files are never overwritten; use `configure` to select an existing file. Repeating `init` on an already migrated installation is a read-only check.

`--output /path/to/monitors.toml` chooses another new file. The root reference is relative to the root TOML's directory, independent of the process working directory. If creating the file succeeds but saving the root reference fails, the unselected file is retained; check it and use `configure` to complete migration.

Older Bridge binaries do not resolve `bridge.monitors_file`. Deploy the supporting version before migration. Installations without the root reference continue to use their inline monitoring settings.

## Editing and applying

The [commented example](monitors.example.toml) shows all sources. To select a manually prepared file:

```sh
lark-channel-bridge monitors check /path/to/monitors.toml
lark-channel-bridge monitors configure /path/to/monitors.toml
```

`configure` selects that file directly; subsequent edits to it are authoritative. It replaces the complete monitoring configuration: omitting a source disables/removes its configuration rather than inheriting stale inline settings. `check` validates syntax, known fields, ranges, required settings and executor/screening references without reading credentials or contacting Lark, GitLab or a model. `status` reports the selected path and configured sources; it does not make live requests. For storage it also includes the last persisted collection state; compare timestamps before treating that state as current.

Each running source manager checks configuration every 15 seconds, including when no web page is open. Slow shutdown/setup can delay application. Invalid or missing selected files leave an already running source on its last valid settings and expose an error; they never silently reactivate inline monitoring settings. A stopped/offline executor is still stopped even when the file is invalid. Repairing the file resumes normal configuration reload.

The workbench shows the file path. Its Lark settings, mode and scope controls write this file. The legacy `ci-watch configure <json>` command also writes the GitLab section here once migration is selected. The writer holds the shared configuration lock, preserves the other source's values, checks for external edits before writing, saves the previous text as `monitors.toml.bak`, and atomically replaces the file. Programmatic edits normalize formatting and regenerate explanatory comments; the backup retains user comments. Repeated no-op saves leave the file and backup untouched. Workbench configuration drafts carry a revision; saving an older draft after another Lark configuration change is rejected. Reload settings after manual file edits before saving a draft configuration.

## Fields and boundaries

- `version = 1` is required. Sources are `[sources.lark]`, `[sources.gitlab_ci]` and `[sources.storage]`; unknown source names and misspelled keys are rejected.
- Lark and GitLab use `enabled`, `executorProfile` and `pollSeconds` (integer seconds, 1–3600).
- Lark uses `intakeScope`, `attentionProfile`, `analysisModel`, optional `triageService`/legacy screening fields, and `[sources.lark.destination]`. Existing context, quota, H5 and GUI fields also round-trip.
- `ownerOpenId` identifies the human owner. Put an explicit name-to-ID binding in `attentionProfile` when screening needs to interpret names; this background is sent to both screening and analysis. Editing this existing field requires no binary upgrade and follows the configuration reload behavior above. Preserving structured mention details and validating model-cited mention IDs require a runtime that includes those code changes; a background edit alone cannot provide them.
- Versions supporting `sources.lark.analysisTimeoutMinutes` allow 1–1440 integer minutes (default 30) for each Lark item's analysis, including retry waits. The Lark settings page exposes the same value. Changing only this field applies to subsequent analyses without recreating the service or changing running deadlines; file edits are detected by the 15-second configuration check. Screening and other monitoring sources keep their own limits. Older binaries reject the TOML key; upgrade before adding it.
- Lark `triageMessageLimit` (2–100, default 12) and `triageMessageChars` (200–16000, default 2000) control initial screening excerpts. Versions supporting these fields replace the earlier fixed 6-message/500-character defaults. The excerpt retains the earliest stored message and recent substantive messages; long messages include both head and tail with explicit truncation metadata. Known bot progress/empty-status messages do not consume the message slots. Missing evidence can be fetched with read-only tools. `maxContextChars` still limits stored history; these settings cannot restore messages already discarded from storage. Completed-analysis additions remain unabridged, and batch sizing accounts for the configured excerpts.
- These two limits can also be edited in the Lark settings page. Like `attentionProfile`, changes are detected by the 15-second configuration check and recreate the inbox service, cancelling its in-flight screening/analysis. They do not automatically rescreen existing quiet items. Older binaries reject these keys; upgrade before adding them to TOML.
- GitLab uses `url`, `tokenEnv` or `credentialsFile`, `model`, `outputDir`, `[[sources.gitlab_ci.repositories]]`, and optional `notification`/`notification.destination` tables. Its detailed behavior remains in [GitLab CI reference](gitlab-ci-watch.md).
- `analysisModel = ""` / `model = ""` follows the executor defaults. Omission preserves the existing legacy background-model policy. Migration preserves that distinction.
- Credentials remain in existing profile/model-service stores, environment variables or referenced credential files. This file does not accept raw token/API-key fields. Relative credential, output and source directory paths are not introduced; the existing absolute-path contracts apply.
- Storage uses `[sources.storage]` with `clusters`, `platforms` and `watches` arrays. Its two subscription kinds are `cluster` and `user` (numeric platform `uid`). See [storage monitoring](storage-monitoring.md) for signals, task discovery, coverage and recovery semantics. It stays disabled until explicitly configured and enabled. Earlier binaries that only support Lark/GitLab reject the new section; upgrade before adding it.

The configuration file controls subscriptions/settings only. Observations, source cursors, evidence, investigation state and delivery receipts stay in their existing durable stores. Source implementation contracts are described in [work-item sources](work-item-sources.md).
