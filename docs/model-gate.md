# Model gate

A bridge-wide limit on model requests, counted per model provider. It exists
because a provider quota belongs to an endpoint and a credential, not to a
workflow: two hundred agents may be alive, but the provider only tolerates so
many requests a minute and so many at once.

The gate holds a permit only while the provider is answering. A run executing
tools — bash, builds, test suites, model checkers — holds nothing, so another
run takes the slot. That is what lets a fan-out of two hundred agents run on a
concurrency budget of one hundred.

```
worker A:  [model call]──────────[tools]──────────[model call]──
worker B:            [model call]──────────[tools]──────────...
                     ↑ A's permit was released when its answer was finalized
```

**Scope of this phase: Pi CLI runs.** Only runs through the Pi CLI adapter load
the extension. Other engines keep their own behaviour; the gate does not see
their requests.

## Configuration

```toml
[gate]
enabled = true
fail_open = true            # a gate that cannot be reached lets runs proceed
lease_seconds = 600         # a permit not released in time is reclaimed

[gate.defaults]
rpm = 1000                  # requests per minute, refilled continuously
burst = 100                 # back-to-back requests after an idle period
concurrency = 100           # requests in flight at once

# Per-provider overrides. The key is the provider id Pi reports for the model
# (`ctx.model.provider`), which the bridge also uses when it registers the
# provider. Unset fields inherit `[gate.defaults]`.
[gate.providers.deepseek]
rpm = 1000
concurrency = 100
```

`rpm` and `concurrency` are independent: the first smooths how fast requests
start, the second bounds how many are unanswered. A request needs both a token
and a free slot.

`burst` cannot exceed `rpm`: a burst larger than a minute of refill would make
the first second of a minute indistinguishable from an outage.

Limits are read once per bridge process and are shared by every profile and by
every run in it. A second bridge process on the same machine finds the same
socket and shares the same buckets — which is the behaviour a shared quota
wants — and logs `reuse-existing`.

## How a permit is taken

The Pi CLI has no hook the bridge can call from outside, so the bridge loads an
extension into every Pi run (`--extension <dist>/pi-model-gate.js`) when the
gate is enabled:

| Event | Action |
|---|---|
| `before_provider_request` | ask the gate for a permit; the handler is awaited, so the request waits |
| `message_end` (assistant) | release the permit — before any tool call from that answer runs |
| `agent_end`, `session_shutdown` | release anything still held |

Interactive runs (no workflow deadline) ask with priority 0; workflow workers
ask with priority 1. Within a priority class the queue is FIFO.

A run that dies without releasing leaks nothing: the permit carries a lease and
the gate reclaims it.

## Failure behaviour

- No `[gate]` table, or `enabled = false`: nothing starts and Pi runs are
  launched exactly as before.
- The gate cannot start (port taken, permissions): a warning is logged, runs
  proceed unthrottled.
- A run cannot reach the gate (`fail_open = true`): the request proceeds and one
  line is written to stderr. The provider's own rate limit stays the backstop.
  Set `fail_open = false` only if the limit is a hard requirement and you accept
  that an unreachable gate stalls runs.

## Observability

- `GET /status` on the socket returns, per provider, `rpm`, `burst`,
  `concurrency`, `tokens`, `inflight`, `queued` and `oldestWaitMs`.
- The gate logs `status` at most once a minute while any bucket has work in it,
  and `permit-expired` when a lease is reclaimed.

## Not covered

- Runs on other engines (Claude, Codex, Agy) are not gated in this phase.
- Requests Pi makes outside the agent loop's provider calls — if a future Pi
  release adds any — bypass the extension.
- Token-weighted limits (ITPM/OTPM) are not implemented; every request costs one
  token regardless of context size.
