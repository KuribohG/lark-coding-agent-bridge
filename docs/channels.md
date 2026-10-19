# Channel plugins and standalone browser chat

The bridge has a shared conversation runtime and separate channel plugins. The
Lark plugin owns SDK startup, inbound normalization, mentions, topic replies,
CardKit callbacks and COT. The Web plugin owns a local HTTP server, the bundled
chat page and JSON streaming. Agent adapters accept host-provided instructions;
they no longer assume the conversation takes place in Lark.

```text
Lark events -> Lark plugin (context/access/attachments) --+
                                                       +-> run policy / session catalog
Browser    -> Web plugin -> ConversationRuntime --------+   -> RunExecutor -> agent
New IM     -> IM plugin  -> ConversationRuntime --------+         |
                                                                 v
                                                 RunOutputPlugin / RunState
                                                 /                       \
                                        Lark cards/COT             Web JSON stream
```

`ChannelHost` connects and closes configured plugins. A plugin's `connect()`
returns a connection with `close()`. Registering a duplicate instance ID fails;
shutdown attempts to close every connected plugin even if one fails. Factories
are statically imported or supplied by the embedding application; this API does
not download or execute plugin names from chat messages or browser requests.

## Run the bundled Web channel

```sh
lark-channel-bridge web --agent codex --workspace /absolute/project/path --port 8787
# or
lark-channel-bridge web --agent claude --workspace /absolute/project/path --port 8787
```

Open the printed URL. No Lark account, app secret, Lark profile, Lark CLI binding
or Lark WebSocket connection is required. An installed, authenticated agent CLI
is still required. `--binary`, `--model` and `--state-dir` customize that host.
This command starts browser chat; `run --web-ui` still starts the existing Lark
profile management console.

The page supports new conversations, streamed progress and final answers,
supplemental input when supported by the selected agent, and stopping the active
run. The server persists native session IDs; the browser keeps its conversation
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

## Integrate another IM

Public package entry points:

| Import | Purpose |
| --- | --- |
| `lark-channel-bridge/runtime` | `ChannelHost`, `ChannelPlugin`, `ConversationRuntime`, agent and output contracts |
| `lark-channel-bridge/channels/lark` | `createLarkPlugin`, `createLarkRunOutput` |
| `lark-channel-bridge/channels/web` | `createWebPlugin`, `createWebChatRuntime`, `createWebRunOutput` |

A new IM plugin owns its SDK, credentials, incoming-message normalization,
authentication, channel-specific UI and connection lifecycle. It creates a
`ConversationRuntime` with its `channelId`, instance `namespace`, private
`stateDir`, `RunProfileConfig`, agent adapter and `authorize` callback. That
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

Call `runtime.close()` on plugin shutdown. It rejects new work, aborts queued and
active requests, waits for output consumers, then flushes session state. Each
runtime needs an exclusively owned state directory. For a multi-user Web host,
provide authenticated identity, per-conversation authorization and workspace
isolation in that host; do not take `actorId` or filesystem paths from its JSON
request body.

## Lark compatibility and verification

Existing Lark profile launchers continue through a compatibility entry point to
the Lark plugin and `ChannelHost`. Lark's richer context/access preparation feeds
the same `startRunFlow`, policy, session catalog and `RunExecutor` used by the
generic runtime. Its slash commands, management console, monitoring destinations
and CardKit forms remain Lark features. A new IM does not need to emulate them or
return a fake `LarkChannel`. They are not automatically exposed as generic IM
commands by this change.

The Web integration tests deliberately throw if the Lark SDK is imported. They
exercise no-credential startup, HTTP streaming, session persistence, channel and
user isolation, authorization, input, cancellation and failed output cleanup.
Existing Lark flow tests cover its compatibility path. This second working
channel is the test of the shared boundary, not just a TypeScript interface.
