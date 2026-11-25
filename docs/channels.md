# Channel plugins, browser chat, and Slack

[Documentation index](README.md) · [Web startup and usage (中文)](user-guide/web-chat.md) · [Quick start](quick-start.md)

This page describes the CLI and plugin contract. Start with the linked Web guide for page controls, token URLs, configuration and troubleshooting.

The bridge has a shared conversation runtime and separate channel plugins. The
Lark plugin owns SDK startup, inbound normalization, mentions, topic replies,
CardKit callbacks and COT. The Web plugin owns a local HTTP server, the bundled
chat page and JSON streaming. Agent adapters accept host-provided instructions;
they no longer assume the conversation takes place in Lark.

```text
Lark events -> Lark plugin (context/access/attachments) --+
Slack events -> Slack plugin (Socket Mode/threads) ------+
Browser     -> Web plugin -> ConversationRuntime --------+-> run policy / session catalog
New IM      -> IM plugin  -> ConversationRuntime --------+   -> RunExecutor -> agent
                                                                 v
                                                 RunOutputPlugin / RunState
                                                 /            |            \
                                        Lark cards/COT  Slack messages  Web JSON stream
```

`ChannelHost` connects and closes configured plugins. A plugin's `connect()`
returns a connection with `close()`. Registering a duplicate instance ID fails;
shutdown attempts to close every connected plugin even if one fails. Factories
are statically imported or supplied by the embedding application; this API does
not download or execute plugin names from chat messages or browser requests.

## Feature plugins

Channel transport and host features are separate extension points:

```text
AgentBackend    Codex / Claude / Pi
ChannelPlugin   Lark / Web / another IM
BridgePlugin    work items, inbox commands and workbench routes
                         |
                  PluginHost / Supervisor
```

A `BridgePlugin` owns a stable ID, lifecycle (`reconcile`, `close`) and optional
command and HTTP-route contributions. `PluginHost` validates duplicate IDs,
commands and routes, reconciles every plugin independently and closes them in
reverse order. `Supervisor` only stores that generic registry; it has no getter
or branch for a concrete inbox implementation. The management console dispatches
plugin HTTP routes through the same authenticated server, and slash-command help
is built from the active command registry.

The built-in work-item/inbox feature is composed in `src/plugins/defaults.ts`.
Its implementation contributes `/inbox`, the `/api/inbox/*` workbench routes,
monitor lifecycle and SQLite-backed work-item storage. Core command, UI and
supervisor modules do not import `src/inbox`,
`src/monitoring/sources/lark` or the concrete plugin. Static architecture tests
enforce that direction. Plugins still run in-process and are explicitly
registered; this contract does not introduce remote code loading.

## Run the bundled Web channel

```sh
lark-channel-bridge web --workspace /absolute/project/path --port 8787
# optional initial engine override
lark-channel-bridge web --agent codex --workspace /absolute/project/path --port 8787
```

Open the printed URL. No Lark account, app secret, Lark profile, Lark CLI binding
or Lark WebSocket connection is required. An installed, authenticated agent CLI
is still required. With `--config`, the active profile supplies the initial
backend and `channels.web` display settings; `--profile` selects another profile
and `--agent` remains an optional initial override. `--binary`, `--model` and
`--state-dir` customize that host.
This command starts browser chat; `run --web-ui` still starts the existing Lark
profile management console.

The page requests everything relative to its own address, so a host that
already authenticates its users can bring it to them under any path prefix.
`--state-file <path>` records the address, the token and the process ID (mode
0600, removed on exit) for such a proxy, which adds the token as `x-ui-token`;
a page opened without a token asks anyway and the server's answer decides. The
proxy must send its own `Host` and no `Origin`, must not buffer `api/stream`,
and owns authentication and cross-site request protection. A host document
that cannot reach the server over HTTP at all may define
`window.__bridgeChatFetch` (the contract is `fetch`'s, streamed bodies
included) before the page script runs.

On Windows, run the same command in PowerShell:

```powershell
node .\bin\lark-channel-bridge.mjs web --agent codex --workspace "C:\projects\my-app" --state-dir ".\web-state" --port 8787
```

Codex uses the installed CLI's existing home, login and model-provider settings
by default (`CODEX_HOME`, or its normal user directory). There is no need to copy
API keys into the bridge. Set `agents.codex.launch.codexHome` or explicitly set
`inheritCodexHome = false` in TOML only when an isolated configuration is intended.

For a custom Responses provider, the optional Windows background launcher reuses
the native model/provider settings with a separate Codex home. This avoids sharing
session writers, desktop plugins and notification hooks with a running Codex app:

```powershell
.\bin\windows\start-web.ps1 -Workspace "C:\projects\my-app" -OpenBrowser
.\bin\windows\stop-web.ps1
```

Both scripts accept `-StateDir`; use the same directory when stopping or restarting.
New installations default to `%USERPROFILE%\.lark-web\<repository-hash>` to
keep Codex's daemon socket path short. The start
script prints the authenticated URL, binds only localhost, runs the server hidden,
and waits for an old state lock to expire on immediate restart. The stop script
checks the recorded process identity before terminating its process tree.

The launcher accepts `-CodexBinary` (or `CODEX_CLI_PATH`) for an explicit CLI
entry point. Otherwise it checks `codex.cmd`, then `codex.exe` on PATH, then the
desktop installation. Daemon mode needs a complete Codex installation; a copied
`codex.exe` alone may lack its daemon package. Install the matching full package
when Codex reports missing package metadata or companion files.

If Codex reports a socket path length error, stop the Web app and its private
Codex daemon before moving the **entire** state directory to a shorter location,
then pass that location as `-StateDir` to both scripts. Keep the directory private
to your Windows account. A junction to a long path may still resolve to the long
physical path. Existing state is never moved automatically.

The isolated launcher reads a custom `wire_api = "responses"` provider from the
native Codex config. Bearer tokens and literal HTTP header values are passed only
through child-process environment variables; generated configuration contains
environment references, not their values. It does not copy login files or change
the native config. Use the normal `web` command above for OAuth-only or other
provider configurations.

The page supports new conversations, streamed progress and final answers,
supplemental input when supported by the selected agent, and stopping the active
run. It also switches an idle conversation between Claude Code, Codex CLI and Pi,
subject to the selected profile's permission compatibility (Pi requires
`read-only` or `full` and cannot emulate a workspace-only sandbox).
Each engine has an isolated native-session key, so switching away and back can
resume the matching backend without passing a Claude session to Pi or Codex. The
server persists native session IDs; the browser keeps its conversation
ID and displayed transcript locally. Use the same URL origin, state directory
and workspace to continue after a restart. A workspace or policy change starts
a fresh native session. Transcript history is browser-local, not a synchronized
multi-device history service.

The built-in server binds to `127.0.0.1`. Its random token stays in the URL fragment
until the page moves it to session storage, and API calls use a header. The local
operator gets workspace access. Browser fields cannot choose an actor, workspace,
permission level, executable or system prompt. A browser disconnect cancels that
run; this first version does not replay an interrupted HTTP stream. This is a
local operator component, not a public multi-user deployment preset.

## Run the bundled Slack channel

The Slack plugin uses Socket Mode, so the bridge does not need a public callback
URL. A Slack thread maps to one bridge conversation:

- a top-level channel mention starts a new thread and a new native session;
- replies in a thread the bridge has seen continue that session without another
  `@` mention;
- a new top-level message starts a separate conversation;
- DMs work without mentions.

Create a Slack app with Socket Mode enabled, install it to the target workspace,
and configure:

- App token with `connections:write`;
- bot scopes `app_mentions:read`, `chat:write`, `reactions:write`,
  `im:history`, `channels:history`, and `groups:history`;
- bot events `app_mention`, `message.im`, `message.channels`, and
  `message.groups`;
- the bot invited to every channel that should be usable.

Store the Slack tokens through the encrypted bridge keystore rather than placing
them in command lines:

```sh
lark-channel-bridge secrets put slack-bot-token --profile codex
lark-channel-bridge secrets put slack-app-token --profile codex

lark-channel-bridge slack \
  --profile codex \
  --agent codex \
  --workspace /absolute/project/path \
  --allowed-users U01234567 \
  --allowed-channels C01234567
```

`--allowed-users` is mandatory unless `--allow-all-users` is explicitly set.
Omitting `--allowed-channels` leaves the bot DM-only. The authenticated Slack
team is pinned automatically; `--team-id` adds an additional expected-team
check. Slack users cannot select a local workspace, executable, permission mode,
or system prompt.

The channel supports `/help [command]`, `/status`, `/stop`, `/new`, `/model`
and `/effort` in text; the last two show or set the thread's model and
reasoning effort (`/model <model|default> [effort]`, `/effort <level|default>`),
from its next run on. Slash command names, aliases, argument modes and help text come from the
shared command catalog in `src/commands/catalog.ts`, and the handlers in
`src/commands/conversation.ts` need only a `ConversationRuntime`, so any
runtime-backed front end exposes them; Slack supplies the reply surface through
`src/channels/slack/command-channel.ts`. Startup fails if a catalogue command for
the `slack` channel has no handler, or a handler is no longer in the catalogue.

Slack also runs workflows (`workflows: true`, set by the `slack` command):
`/workflow …` in a thread is handled by the conversation runtime, and
`src/channels/slack/events.ts` subscribes that conversation's event stream so
workflow turns, notices and worker-report wakes appear in the same thread. Those
runs have no answer UI, so Slack disables the question sink for runs the runtime
starts itself.

Progress for ordinary messages reuses and updates one thread message, then
replaces it with the final answer. `[channels.slack]` controls `show_tools` and
`show_progress`.

## Integrate another IM

Public package entry points:

| Import | Purpose |
| --- | --- |
| `lark-channel-bridge/runtime` | `ChannelHost`, `ChannelPlugin`, `PluginHost`, `BridgePlugin`, `ConversationRuntime`, agent and output contracts |
| `lark-channel-bridge/channels/lark` | `createLarkPlugin`, `createLarkRunOutput` |
| `lark-channel-bridge/channels/slack` | `createSlackPlugin`, `createSlackRunOutput`, Socket Mode and Web API adapters |
| `lark-channel-bridge/channels/web` | `createWebPlugin`, `createWebChatRuntime`, `createWebRunOutput` |

A new IM plugin owns its SDK, credentials, incoming-message normalization,
authentication, channel-specific UI and connection lifecycle. It creates a
`ConversationRuntime` with its `channelId`, instance `namespace`, private
`stateDir`, `RunProfileConfig`, shared `ExecutionController` and `authorize`
callback. That
configuration needs no messaging account. Its inbound handler calls:

```ts
const run = await runtime.start(
  { actorId: authenticatedSender, conversationId, prompt: normalizedText },
  outputForThisConversation,
);
if (run.ok) await run.done;
else await replyWithRejection(run.rejectReason.userVisible);
```

`RunOutputPlugin.render(context)` consumes normalized `AgentEvent`s, with access
to the common `RunState` reducer and stream processor. An output adapter renders
the result using its platform's primitives. It must reject on failed delivery
and must finish consuming the stream before resolving. A rejected output stops
its execution. Lark's adapter retains its existing streaming fallback, receipt
checking, COT and card behavior; Web publishes JSON snapshots with a monotonically
increasing sequence within each run, and only one terminal snapshot.

The generic runtime checks authorization on start, stop and supplemental input.
Session keys include channel, namespace, actor and conversation; native session
reuse additionally requires a matching workspace and policy fingerprint. Stop
and supplemental input require the current run ID. Unknown input delivery is
reported as unknown and must not be automatically replayed. The runtime retains
the existing concurrency limit, cancellation, deadline and retry machinery.

To let the agent ask the person a question, pass a `questions` sink with the
input. `ask({ id, mode, questions })` shows the question; `settled({ id, status })`
replaces its inputs with the outcome. The host returns the reply with
`runtime.answerQuestion(identity, id, answers)`, one list of answers per
question, and shows the returned `message` whether or not it was taken. A
`blocking` question holds the run until it is answered, declined after 30
minutes, or the run stops; an `async` one arrives as follow-up input. Without a
sink the agent is not offered the question tool. Web streams these as
`run.question` and `run.question.settled` and accepts `POST /api/answer`. Runs
the runtime starts itself (`submit` and workflow turns) publish questions to the
event stream by default; a host with no answer UI sets `questionSinks: false`
when creating the runtime, and those runs are then never offered the tool.

### Conversation event streams

`runtime.start()` ties a run to the output its caller passed. A front end that
connects and disconnects on its own schedule, or runs in another process, uses
the conversation's event stream instead:

```ts
const stop = await runtime.subscribe(identity, { stream, after }, event => send(event));
const run = await runtime.submit({ ...identity, prompt });   // { ok: true, runId } or a rejection
```

A submitted run does not depend on any subscriber being connected. Every
subscription starts with `{ type: 'stream.opened', stream, sequence }`, then
replays the buffered events after the cursor, then delivers live ones:

| Event | Meaning |
|---|---|
| `run.started` | A run began; `runId` addresses stop, supplemental input and its questions |
| `run.state` | Full `RunState` snapshot, filtered by the host's `filterState`; replaces earlier states of the run |
| `run.question` / `run.question.settled` | A question to answer with `answerQuestion`, and its outcome |
| `run.finished` / `run.failed` | The run's result, or that its output failed |

Each event carries a `sequence` that increases within the stream but is not
dense: superseded state snapshots are dropped and the buffer keeps the latest
256 events per conversation. A cursor is valid only for the `stream` that issued
it; after a restart the stream id changes and the buffer starts empty, so a
client keeps its own transcript and treats a new id as a fresh stream.

`{ type: 'notice', text }` is something the bridge tells the conversation
outside any run, such as a workflow's plan.

A host that keeps its own record of conversations passes `observe(identity,
event)` when it creates the runtime. It is called in order with every event the
runtime publishes, whether or not anyone is subscribed, so the record does not
depend on the 256-event buffer or on a connected client.

With `workflows: true` the runtime hosts workflows for its conversations:
`runtime.workflowCommand(identity, args)` handles `/workflow <args>` and returns
the reply to show, or `undefined` when it queued a turn. Workflow turns wait
behind the conversation's active run, and a worker's report wakes the main
session on its own; both appear in the event stream like any submitted run.
Workflow state lives in `workflows.sqlite` in the runtime's state directory.
The `web` command enables this; Web accepts the command
as `POST /api/command` (`{ conversationId, text: "/workflow …" }`).

With `modelChoice` the runtime keeps a model, model service and reasoning effort
per conversation and engine, in `scope-preferences.json` in its state directory:
`modelSettings(identity)` says what the next run uses and where each value comes
from (the conversation, the engine profile, or the engine's own configuration),
`setModelSettings(identity, patch)` changes the conversation's choice (a value
sets it, `null` returns it to the default) and refuses a model and effort that
do not go together, and `modelChoices(identity)` lists the models, model
services (`modelChoice.providers`) and efforts to choose from. A run that is
going keeps what it started with; a workflow runs with its conversation's
choice. `engine(identity, kind)` says whether an engine can be used on this
machine. Without `modelChoice` every conversation runs with its engine
profile's settings and `setModelSettings` refuses. The `web` and `slack`
commands enable it.

`rawThinking` asks engines for the model's own thinking where they otherwise
keep it back (Claude Code's thinking blocks). It is for a host that folds
reasoning away until someone asks for it, as the Web page does; shown in line
it buries the answer, so Lark and Slack leave it off. With it the Claude
adapter also asks Claude Code, at the start of each run, to have the API return
the thinking as text (for Claude models, a summary of it): run without a
terminal Claude Code otherwise leaves the blocks empty. A Claude Code too old
to know the request ignores it. A step the model did not think about has no
thinking to show either way.

Every `run.started` event carries `settings`: the engine, and the model and
effort where the bridge chose them.

Web also takes the shared conversation commands there: `/help`, `/new`,
`/status`, `/stop`, `/model` and `/effort` run without starting a run, and the
reply comes back as `{ reply }` text. `src/channels/web/command-channel.ts` collects what
the shared handler says instead of posting it; the Markdown form goes into the
conversation's record.

Web exposes the event stream as `GET /api/events?conversationId=…[&stream=…&after=…]`
(NDJSON, open until the client disconnects) and `POST /api/send`
(`{ conversationId, text[, messageId] }` returning `{ runId }`). Stop,
supplemental input, answers and engine selection use the existing `POST`
endpoints. `POST /api/chat` remains as the single-request form of the same run.

### The Web channel's record and page

The chat page keeps nothing but its settings and unsent drafts in the browser.
`src/channels/web/transcript.ts` records every conversation under
`<state-dir>/web-chat`: `index.json` lists the conversations (title, pinned,
last activity, the run that is going), and each conversation is an append-only
JSONL file of items — what the person sent, each run with its blocks and what
it was started with (engine, model, effort), notices and questions. A run's
blocks are in the order things happened: text, tool calls, and each stretch of
the model's reasoning where it came (the runtime keeps reasoning as one text
apart from the blocks; the record notes where each addition arrived). The record is fed by the runtime's `observe` hook and by the
`POST` handlers, so a conversation reads the same from any browser and after a
restart. A run that was going when the service stopped is shown as interrupted.
Long tool input and output are clipped in the record; the agent's own session
is unaffected.

The page reads through these routes, all behind the same token:

| Route | Returns |
|---|---|
| `GET /api/meta` | Version, the page's build, workspace, default and available engines, display settings, whether workflows are on, the slash commands |
| `GET /api/conversations` | The conversations, pinned first, then by last activity |
| `GET /api/stream[?conversationId=…&epoch=…&since=…&tail=…]` | NDJSON, open until the client disconnects: the conversation list whenever it changes, and the items of the one conversation the page shows |
| `GET /api/items?conversationId=…&before=…[&limit=…]` | An older page of that conversation's items |
| `GET /api/state[?conversationId=…]` | Engine, active run, working directory; the model, model service and effort of the next run, where each comes from (`sources`), and what the conversation chose itself (`overrides`). Without a conversation: what a new one would begin with |
| `GET /api/models?agent=…[&conversationId=…&refresh=1]` | The models, model services and efforts to choose from for an engine, and what a conversation that chose nothing runs with |
| `GET /api/engines` | Each engine with whether it can be used on this machine, and why not |
| `POST /api/engine` | `{ conversationId, agent }`; refused with 409 while a run is going |
| `POST /api/model` | `{ conversationId[, agent], model?, provider?, effort? }`: a string chooses, `null` returns to the default, an absent key is left alone. Answers like `GET /api/state`; 400 with the reason when the choice cannot be used |
| `GET /api/workflows?conversationId=…`, `GET /api/workflows/…` | The conversation's workflows, then the read-only [dashboard API](workflow-dashboard.md) for one of them; 404 unless workflows are on |
| `POST /api/conversation`, `POST /api/conversation/delete` | Rename or pin (`{ conversationId, title?, pinned? }`); delete, refused with 409 while a run is going |

One connection per tab carries both the list and the open conversation, because
a browser allows few connections to a host. Within a conversation every change
has a revision. The stream opens with `{ type: 'open', epoch, reset }`, sends
the items the client is missing, then `ready`, then live changes: a whole
`item` when one appears or settles, and for a run that is going a `run` patch
holding only the blocks from the first changed one — and, when that block is
text or reasoning that grew at its end, only what was added (`keep` says how
much of it the client already has). A patch names the revision
it builds on; a client that does not hold that revision reconnects with its
cursor (`epoch` and `since`) and is sent the items again. `epoch` changes when
the service restarts or the record is rewritten, and the client then starts
from the tail. `messageId` on `POST /api/send` becomes the key of the recorded
message, so the page can show it before the server confirms it and a retry is
not recorded twice. `open` also names the build of the page the server serves;
a page that holds another build offers to reload.

What the person last chose in the page — the engine, and each engine's model
and effort — is kept in `<state-dir>/web-chat/defaults.json`. A conversation is
given it when it begins (its first message, command or choice) and keeps its
own from then on, so a later choice elsewhere does not change it.

The page itself is a React app in `web/chat`, built by Vite into one
self-contained HTML file that tsup inlines into the bundle, like the console.
`web/shared` holds the design tokens and primitives the bridge's pages share.

Call `runtime.close()` on plugin shutdown. It rejects new work, aborts queued and
active requests, waits for output consumers, then flushes session state. Each
runtime needs an exclusively owned state directory. For a multi-user Web host,
provide authenticated identity, per-conversation authorization and workspace
isolation in that host; do not take `actorId` or filesystem paths from its JSON
request body.

## Lark authentication boundaries

One bridge process can connect two independent Lark apps using two profiles:

```sh
lark-channel-bridge run --config /absolute/private/config.toml --profiles frontend_a frontend_b
```

See the [two-frontend example](user-guide/examples/lark-two-frontends.toml).
Both profiles must already exist and use different app IDs. A startup failure
closes every profile started by this command; Ctrl-C closes both. This headless
mode does not start a management console and cannot be combined with `--profile`,
`--web-ui` or bootstrap flags. For console management, configure
`bridge.autostart_profiles` and use `run --web-ui`.

Each incoming transport selects its profile's reply connection, execution
controller, session store and CLI environment. Two frontends may share a code
workspace without sharing conversation or OAuth state. Authorize each app in
its own bot's DM. Agent homes follow the global `[state]` layout and may be
shared; Codex shell bindings are supplied per thread. The example selects
distinct Codex homes to isolate persistent daemon and MCP environments as well.
Profile separation does not sandbox access
to the shared filesystem.

Lark credentials and protocol tokens have separate owners:

- A profile's `SecretRef` resolves the long-lived App Secret from the encrypted
  keystore, an environment variable, a mounted file or an exec provider.
- `LarkProfileAuth` owns one profile's resolved credentials, tenant-token
  provider and callback keys. The Lark channel, inbox and monitoring adapters
  receive this object instead of resolving or caching credentials separately.
- `TenantTokenProvider` is the only component that exchanges App ID and App
  Secret for a short-lived tenant token. It single-flights refreshes and caches
  the token until shortly before expiry. CoT, H5 ticket acquisition and
  credential validation all consume this provider.
- Card callback signatures use a purpose-specific key derived from the App
  Secret. Version 1 remains verify-only for cards issued before the refactor;
  new cards use the active derived key.
- Lark user OAuth remains owned by `lark-cli`; it is not derived from or mixed
  with the application tenant token.

The shared execution runtime does not import the Lark SDK or construct agent
environment/prompts. `channels/lark/agent-host.ts` supplies those values, while
`ProfileExecutionController` only consumes injected environment and prompt
objects. Lark, Slack and standalone Web all obtain their controller from
`runtime/execution-host.ts` (`openExecution`), which owns the `scope-agents.json`
store, model services and the availability check; an architecture test rejects
a controller or store constructed anywhere else. Work-item monitoring similarly depends on `WorkItemDeliveryPort`;
`monitoring/sources/lark/work-item-delivery.ts` is the Lark implementation.

Agent session and image semantics are declared by each backend capability.
Runtime code uses `sessionIdField`, `imageInput` and `legacySessionStore` rather
than checking for Claude, Codex or Pi by name.

Launch scripts therefore do not need to inject credentials before every
command. A container should provide them through its secret manager and run the
canonical CLI in the foreground:

```sh
lark-channel-bridge run --profile codex
```

For a source checkout, run `node bin/lark-channel-bridge.mjs run --profile
codex` after building. Use `lark-channel-bridge run --web-ui --detach` only when
the local Web management console is wanted.

## Lark integration and verification

Lark profile hosts connect through the Lark plugin and `ChannelHost` with the
profile's `ExecutionController`. Lark's richer context/access preparation feeds
the same turn pipeline as the generic runtime: `runMessageTurn()` in
`src/runtime/message-turn.ts` owns model resolution, the message-turn context,
agent entry, `startTurn()` submission, session tracking and the
question/output lifecycle, while a channel supplies only a
`MessageTurnFrontend` (context import and prompt, rejection notice, questions,
presentation). Server-side conversations (`ConversationRuntime`) use the same
host with an event-stream frontend, so a feature of the turn itself is
implemented once for every channel. Lark adds only its own implementation of
those hooks (quotes, topic context, question cards, CardKit output). Its slash commands, management console, monitoring destinations
and CardKit forms remain Lark features. A new IM does not need to emulate them or
return a fake `LarkChannel`: command handlers address a channel through
`CommandChannel` (`src/commands/types.ts`), whose optional capabilities
(`knownChats`, `messageLink`, `hasGroupMessageScope`, `createChat`, `stream`)
decide which of those Lark commands its catalogue exposes. They are not
automatically exposed as generic IM commands by this change.

The Web integration tests deliberately throw if the Lark SDK is imported. They
exercise no-credential startup, HTTP streaming, session persistence, channel and
user isolation, authorization, input, cancellation and failed output cleanup.
Slack tests inject fake Socket Mode and Web API adapters, then cover thread
resumption, deduplication, access checks, command handling, and in-place output.
Existing Lark flow tests cover its channel path. The three working
channels exercise the shared boundary rather than only a TypeScript interface.
