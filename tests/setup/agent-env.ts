/**
 * Tests run inside the bridge often enough (an agent asks for the suite) that
 * they must not inherit the bindings the bridge injects into its agent
 * subprocesses. Those are per-run credentials and private lark-cli/Pi/Claude
 * state directories: a workflow test would talk to the live bridge's IPC
 * endpoint instead of its own, and a lark-cli preflight test would compare
 * against the ambient private config directory. CI has none of them, so
 * dropping them here makes a local run behave like CI.
 */
const INJECTED = /^(AGENT_WORKFLOW_|LARK_CHANNEL|LARKSUITE_CLI_|CLAUDE|PI_|CODEX_)/;
/** Opt-in live tests are configured through the environment and keep theirs. */
const OPT_IN = /^PI_SDK_LIVE_/;

for (const key of Object.keys(process.env)) {
  if (INJECTED.test(key) && !OPT_IN.test(key)) delete process.env[key];
}
