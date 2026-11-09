# Deploying with `up`

[Documentation index](README.md) · [Configuration reference](configuration.md)

`up` keeps a Lark bridge running in the background from one file, `config.toml`, without systemd, launchd or a terminal that stays open. It is meant for servers, containers and dev machines where `start` (an OS service) is not available or not wanted.

```sh
node bin/lark-channel-bridge.mjs up            # start, or bring the running bridge up to date
node bin/lark-channel-bridge.mjs up --plan     # show what would change
node bin/lark-channel-bridge.mjs up --restart  # replace the running bridge even if nothing changed
node bin/lark-channel-bridge.mjs up --rollback # go back to the release that ran before
node bin/lark-channel-bridge.mjs down          # stop it
```

On a machine without any profile, `up` in a terminal first runs the QR registration (`profile create default`), then starts the bridge.

## The `[deploy]` table

Every key is optional. Without the table, `up` runs the installation you invoke it from.

```toml
[deploy]
# Build releases from git instead of running this installation.
git = "https://github.com/KuribohG/lark-coding-agent-bridge.git"
ref = "dev"                     # branch, tag or commit; default HEAD
profiles = ["codex", "bot2"]    # default: bridge.autostart_profiles, else bridge.active_profile
node = "/opt/node-22/bin/node"  # default: the Node running up
cwd = "~/work"                  # bridge working directory; default: home
root = "deploy"                 # releases, logs and state; default: <config dir>/deploy
keep = 3                        # built releases kept for rollback
ready_timeout_seconds = 180     # how long a new bridge may take to bring every profile online
env = { HTTPS_PROXY = "http://proxy:3128" }
```

Relative paths are resolved against the config file's directory; `~/` expands to the home directory. A running bridge ignores `[deploy]`: changing it takes effect at the next `up`.

## What `up` does

1. **Resolve the release.** With `git`, `up` keeps a mirror in `<root>/source.git`, resolves `ref`, and builds `<root>/releases/<commit12>` once per commit (`git archive`, then `pnpm install --frozen-lockfile` through the corepack bundled with `node`, with `LARK_BUILD_COMMIT` set). Without `git`, the release is the running installation.
2. **Compare.** The running bridge is found through the profile runtime locks, so a bridge started by hand or by an older script is adopted. If it already runs the same release with the same profiles, node, cwd and `[deploy].env`, `up` changes nothing; other config edits are hot-reloaded by the bridge itself (see `config describe`).
3. **Check.** The target release validates the config (`config check`) before anything is stopped. A target that does not understand the current config is never started.
4. **Hand over.** A detached helper stops the running bridge with SIGTERM (agents under run hosts keep running and are reattached), starts the new one in its own session, and waits until every profile logged `profile「…」已上线` and stayed up for 10 seconds. If that does not happen, the new process is stopped and the previous command line is started again. `up` prints the helper's progress; the helper finishes on its own if `up` is interrupted, which is what lets an agent running inside the bridge deploy it.

The new bridge gets the environment of the shell running `up`, minus the run bindings the bridge injects into its agents (`LARK_CHANNEL*`, `LARKSUITE_CLI_CONFIG_DIR`), plus `[deploy].env`. When `up` runs inside an agent of the bridge it replaces (`LARK_CHANNEL=1`), the running bridge's own environment is used instead of the agent's, which also carries agent-specific state directories. `LARK_CHANNEL_HOME` is set to the config file's directory. Put anything the bridge must always have into `[deploy].env` rather than relying on the shell.

## Files

| Path | Content |
| --- | --- |
| `<root>/state.json` | Current and previous instance: pid, release, profiles, command line (no environment) |
| `<root>/current` | Symlink to the running release |
| `<root>/bridge.log` | Symlink to the running bridge's console log in `<root>/logs/` |
| `<root>/handover/<id>/status.json` | Progress and result of each handover |
| `<root>/releases/<commit12>/` | Built releases with `release-info.json` |

`up` and `down` support Linux and macOS. On Windows use the tray launcher or `start` / `stop`.
