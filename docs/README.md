# Documentation

[English quick start](../README.md) · [中文快速开始](../README.zh.md) · [中文用户手册](user-guide/README.md)

## Start, use, configure

| Task | Guide |
| --- | --- |
| Choose browser chat or the Lark management console | [Quick start](../README.md) |
| Use standalone browser chat; fix token/port issues | [Web chat guide](user-guide/web-chat.md) (中文), [CLI/channel reference](channels.md) |
| Connect a Lark bot for the first time | [Getting started](user-guide/getting-started.md) (中文) |
| Run on Windows, stop/restart, or set up login autostart | [Windows](user-guide/windows.md) (中文) |
| Pick a config file and follow a complete recipe | [Configuration tutorial](user-guide/configuration.md) (中文) |
| Look up field precedence, validation and reload rules | [Configuration reference](configuration.md) |
| Connect Antigravity to Gemini or a provider such as high-five | [Antigravity backend](antigravity.md) |
| Configure native agents or independent model services | [Models and accounts](user-guide/models-and-accounts.md) (中文), [model services](model-services.md) |
| Find a command or runtime behavior | [Command sheet](user-guide/commands.md) (中文), [advanced runtime reference](runtime-reference.md) |

## Examples

- [Web + existing Codex login/provider](user-guide/examples/web-native.toml): no Lark profile or app credential.
- [Web + a Bridge-managed Responses service](user-guide/examples/web-responses.toml): replace endpoint/model and supply an environment credential.
- [Lark + Codex](user-guide/examples/lark-codex.toml): replace the app ID and supply its secret; QR setup is easier for a first bot.
- [Full layered configuration](config.example.toml): a field reference, not the minimum needed to start.

Examples contain placeholders, never usable credentials. Copy to a private file and validate it before launching.

## Optional features and reference

- [Workflows](workflows.md): scripted branches, parallel tasks, replay, and independent harness/model selection; architecture review is an example.
- [Assistant](user-guide/assistant.md), [monitoring](user-guide/monitoring.md), [operations](user-guide/operations.md) — 中文.
- [Self-contained deployment](self-contained.md), [Inbox configuration](inbox-assistant.md), [GitLab CI](gitlab-ci-watch.md), [storage monitoring](storage-monitoring.md).
- [Monitor configuration](monitor-config.md), [task sources](work-item-sources.md), [agent execution contract](agent-execution.md), [channel integration](channels.md).
- [Windows validation and known failures](windows-web-validation.md): what was actually tested, not a guarantee that the full suite is green.

The documentation follows this repository's `dev` implementation. A matching npm version number is not evidence that another package has the same code.
