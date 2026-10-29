# Antigravity CLI backend

Bridge supports `agy` 1.4.10 or newer as an independent backend for Lark, Slack
and browser conversations. Install [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli)
and check `agy --version` in the account that runs Bridge.

## Configure an API provider

An API provider such as high-five can expose both Responses and Gemini native
endpoints. Configure each protocol explicitly; Bridge does not guess a Gemini
URL from a Responses URL or fall back to a Google account.

The following is a partial configuration to merge into your private version 3
TOML. Replace the example host with your provider's actual endpoints and supply
the referenced key in the Bridge environment:

```toml
[model_services.high-five-ai]
protocol = "responses"
baseUrl = "https://gateway.example/v1"
model = "your-responses-model"
apiKey = { source = "env", id = "HIGH_FIVE_API_KEY" }

[model_services.high-five-ai.endpoints.gemini]
baseUrl = "https://gateway.example"
model = "google/gemini-2.5-flash"
contextWindow = 1048576

[agents.agy.launch]
binaryPath = "agy"

[agents.agy.run]
model = "high-five-ai/google/gemini-2.5-flash"
effort = "low"
```

The Gemini `baseUrl` is the server root: agy adds `/v1beta/models/...` itself.
Do not append `/v1`, `/v1beta`, or `/responses` to that root unless the provider
explicitly requires that prefix before the SDK's path. Provider model IDs are
preserved, including namespaces such as `google/`. `contextWindow` is required
for custom Antigravity models and must match the model's total context limit;
the number above is an example for the named Gemini family, not a limit applied
to every future model.

Start a browser conversation with:

```sh
lark-channel-bridge web --agent agy --workspace /absolute/project --config /absolute/private/config.toml
```

For a Lark profile, use `profile create <name> --agent agy`, or select Antigravity
in the setup UI. `LARK_CHANNEL_AGY_BIN` overrides binary discovery. Existing
profiles can select the backend through the usual engine controls, subject to
their access policy. Existing Lark profiles must explicitly allow `full` access
through `profiles.<name>.permissions.defaultAccess` and `maxAccess`; permissions
do not belong in the model/run settings.

The model/provider picker offers the endpoint's default model and can refresh
the provider's model catalog. Catalog failure leaves manual model IDs usable.
No Gemini model version is hardcoded in the adapter. New provider models can be
selected as `<provider>/<model>` without changing Bridge code.

Credentials are resolved from the selected service's environment/file reference
and passed only through the child environment. The adapter uses session-local
`--settings`, `GEMINI_API_KEY`, and `GOOGLE_GEMINI_BASE_URL`; it does not rewrite
your Antigravity settings or copy credentials into generated files. Arbitrary
extra request headers are rejected for this binding because agy does not expose
a corresponding native setting.

## Native Google authentication

Without a Bridge-managed provider, agy uses its own Google account login or native
API-key configuration. Complete account login in a terminal before headless use.
Bridge leaves the native account/configuration directory under agy's control;
there is no fabricated home-directory override. A failed provider request is
reported, not retried with another account.

## Execution contract

- One prompt is submitted on stdin per process. Replies and tool activity use
  `stream-json`; only `result.response` is the final answer.
- The native conversation ID is persisted and explicitly resumed with
  `--conversation`. Shared working directories never imply “resume latest.”
- Text sent during an active task queues for the next turn. The headless input
  protocol does not supply a correlated active-turn acknowledgement.
- Stop uses SIGINT, followed by bounded process-tree termination. Timed runs use
  the existing independent deadline supervisor.
- Only `full` access is advertised. The CLI can silently ignore an unavailable
  sandbox, so Bridge rejects `read-only` and `workspace` instead of claiming
  those restrictions are enforced.
- Native headless approval/control requests and conversation forks are not
  supported. Permission denials appear in progress and tool results; exit code
  zero alone is not a completion signal.
- Images are supplied as absolute local file references for agy's tools. The
  headless protocol itself accepts text blocks, not uploaded image blocks.
- Token usage comes from native metadata. Some API-key runs report zero usage;
  Bridge does not invent an estimate.

## Validation

The regular suite checks protocol translation, provider binding, session
isolation, cancellation, deadlines and the shared Pi process driver with fake
executables. A real provider check is explicitly opt-in:

```sh
LARK_TEST_AGY_BINARY=/absolute/path/agy \
LARK_TEST_AGY_PROVIDERS=/absolute/private/provider-map.json \
LARK_TEST_AGY_WORKSPACE=/absolute/private/smoke-workspace \
LARK_TEST_AGY_MODEL=high-five-ai/google/gemini-2.5-flash \
pnpm exec vitest run tests/integration/agent/agy-native.test.ts
```

The JSON file contains a map of provider names to the same service objects as
`model_services`, with credential references only. The test prints a marker
through a terminal tool and recalls it in a resumed conversation. It does not
connect a messaging account or deploy Bridge.
