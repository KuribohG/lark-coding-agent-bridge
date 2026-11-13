import { describe, expect, it, vi } from 'vitest';
import { parseRootConfig, runtimeProfileConfig } from '../../../src/config/profile-store';
import { reconcileProfile, type ReconcileTarget } from '../../../src/runtime/config-reconciler';
import { formatApplyReport } from '../../../src/config/apply';
import { ReconfigureDeferred } from '../../../src/runtime/execution-controller';

const config = (overrides: { body?: string; profile?: string } = {}) => parseRootConfig(`version = 3
${overrides.body ?? ''}
[profiles.bot]
agent = "claude"
${overrides.profile ?? ''}
[profiles.bot.accounts.app]
id = "cli_a"
secret = { source = "env", id = "S" }
tenant = "feishu"
`, '/tmp/bridge/config.toml');

function target(overrides: Partial<ReconcileTarget> = {}) {
  const root = config();
  const state = { cfg: runtimeProfileConfig(root, 'bot'), profileConfig: root.profiles.bot! };
  const execution = { reconfigure: vi.fn(async (_profile: unknown, _providers: unknown) => {}), updateProfile: vi.fn() };
  const t: ReconcileTarget = {
    profile: 'bot', state, execution, modelServices: {},
    applyLarkCliIdentity: vi.fn(async () => true), onApplied: vi.fn(), ...overrides,
  };
  return { t, state, execution };
}

describe('reconcileProfile', () => {
  it('applies live settings in place and only those', async () => {
    const { t, state, execution } = target();
    const next = config({ profile: 'mode = "personal"\n[profiles.bot.run]\nmax_concurrent_runs = 7\n[profiles.bot.access]\nallowedUsers = ["ou_x"]' });
    const { report } = await reconcileProfile(t, next, { trigger: 'test', revision: 'r1' });
    expect(report.applied.sort()).toEqual(['access.allowedUsers', 'preferences.maxConcurrentRuns']);
    expect(report).toMatchObject({ components: [], pending: [], failed: [], revision: 'r1' });
    expect(state.profileConfig.preferences.maxConcurrentRuns).toBe(7);
    expect(state.cfg.access.allowedUsers).toEqual(['ou_x']);
    expect(execution.reconfigure).not.toHaveBeenCalled();
    expect(execution.updateProfile).toHaveBeenCalledWith(state.profileConfig);
    expect(t.onApplied).toHaveBeenCalledOnce();
  });

  it('keeps reconnect-class settings running and reports them without echoing secrets', async () => {
    const { t, state } = target();
    const next = parseRootConfig(`version = 3
[channels.lark]
progress = "off"
network = { proxy = "http://p:1" }
[profiles.bot]
agent = "claude"
[profiles.bot.accounts.app]
id = "cli_b"
secret = { source = "env", id = "OTHER" }
tenant = "feishu"
`, '/tmp/bridge/config.toml');
    const { report } = await reconcileProfile(t, next, { trigger: 'test' });
    expect(report.applied).toEqual(['channels.lark.progress']);
    expect(report.pending.map(c => [c.label, c.apply])).toEqual([
      ['accounts.app.id', 'reconnect'], ['accounts.app.secret.id', 'reconnect'], ['channels.lark.network.proxy', 'reconnect'],
    ]);
    expect(state.cfg.accounts.app.id).toBe('cli_a');
    expect(state.cfg.channels?.lark?.network).toBeUndefined();
    const text = formatApplyReport(report);
    expect(text).toContain('/reconnect');
    expect(text).toContain('accounts.app.secret.id（已修改，值不显示）');
    expect(text).not.toContain('OTHER');
  });

  it('rebuilds execution make-before-break and keeps the old adapter on failure', async () => {
    const { t, state, execution } = target();
    const next = config({ body: '[agents.claude.launch]\nbinaryPath = "/opt/claude"' });
    execution.reconfigure.mockRejectedValueOnce(new Error('claude not found'));
    const failed = (await reconcileProfile(t, next, { trigger: 'test' })).report;
    expect(failed.failed).toEqual([{ component: 'execution', error: 'claude not found', paths: ['claude.binaryPath'] }]);
    expect(failed.pending.map(c => c.label)).toEqual(['claude.binaryPath']);
    expect(state.profileConfig.claude?.binaryPath).not.toBe('/opt/claude');
    expect(formatApplyReport(failed)).toContain('执行引擎重建失败');

    const ok = (await reconcileProfile(t, next, { trigger: 'test' })).report;
    expect(ok).toMatchObject({ components: ['execution'], pending: [], failed: [] });
    expect(execution.reconfigure.mock.calls.at(-1)![0]).toMatchObject({ claude: { binaryPath: '/opt/claude' } });
    expect(state.profileConfig.claude?.binaryPath).toBe('/opt/claude');
  });

  it('rebuilds providers when model services change', async () => {
    const { t, execution } = target();
    const next = config({ body: '[model_services.svc]\nprotocol = "responses"\nbaseUrl = "https://x.invalid/v1"\nmodel = "m"\n[model_services.svc.apiKey]\nsource = "env"\nid = "K"' });
    const result = await reconcileProfile(t, next, { trigger: 'test' });
    expect(result.report.components).toEqual(['execution']);
    expect((execution.reconfigure.mock.calls[0]![1] as { services: object }).services).toHaveProperty('svc');
    expect(result.modelServices).toHaveProperty('svc');
  });

  it('re-applies the lark-cli identity for mode changes and keeps the old mode when it fails', async () => {
    const applyLarkCliIdentity = vi.fn(async (_identity: string) => false);
    const { t, state } = target({ applyLarkCliIdentity });
    const { report } = await reconcileProfile(t, config({ profile: 'mode = "team"' }), { trigger: 'test' });
    expect(applyLarkCliIdentity).toHaveBeenCalledWith('bot-only');
    expect(report.failed[0]!.component).toBe('lark-cli');
    expect(state.profileConfig.mode).toBe('personal');
    applyLarkCliIdentity.mockResolvedValueOnce(true);
    await reconcileProfile(t, config({ profile: 'mode = "team"' }), { trigger: 'test' });
    expect(state.profileConfig.mode).toBe('team');
  });

  it('reports a removed profile instead of applying anything', async () => {
    const { t, state } = target();
    const root = config();
    delete root.profiles.bot;
    const { report } = await reconcileProfile(t, root, { trigger: 'test' });
    expect(report.pending.map(c => c.label)).toEqual(['profiles.bot']);
    expect(state.profileConfig.accounts.app.id).toBe('cli_a');
  });

  it('ignores standalone Web/Slack display settings in the Lark host', async () => {
    const { t } = target();
    const { report } = await reconcileProfile(t, config({ body: '[channels.web]\nshow_reasoning = true' }), { trigger: 'test' });
    expect(report.pending).toEqual([]);
  });

  it('appends bridge-wide pending items', async () => {
    const { t } = target({ rootPending: () => [{ path: ['autostartProfiles'], label: 'autostartProfiles', apply: 'restart', running: [], disk: ['x'] }] });
    const { report } = await reconcileProfile(t, config(), { trigger: 'test' });
    expect(formatApplyReport(report)).toContain('重启 bridge 后生效');
  });

  it('defers an engine swap that would disrupt active runs and says so', async () => {
    const { t, state, execution } = target();
    execution.reconfigure.mockRejectedValueOnce(new ReconfigureDeferred('Codex 后台服务仍有 2 个任务在运行'));
    const { report } = await reconcileProfile(t, config({ body: '[agents.claude.launch]\nbinaryPath = "/opt/claude"' }), { trigger: 'test' });
    expect(report.failed).toEqual([{ component: 'execution', error: 'Codex 后台服务仍有 2 个任务在运行', paths: ['claude.binaryPath'], deferred: true }]);
    expect(state.profileConfig.claude?.binaryPath).not.toBe('/opt/claude');
    const text = formatApplyReport(report);
    expect(text).toContain('⏸ 执行引擎暂缓切换');
    expect(text).toContain('空闲后自动生效');
  });

  it('leaves the controller on the final view when a later component rolls back', async () => {
    const applyLarkCliIdentity = vi.fn(async () => false);
    const { t, state, execution } = target({ applyLarkCliIdentity });
    const next = config({ profile: 'mode = "team"\n[profiles.bot.permissions]\ndefaultAccess = "read-only"\nmaxAccess = "full"' });
    const { report } = await reconcileProfile(t, next, { trigger: 'test' });
    expect(report.components).toEqual(['execution']);
    expect(report.failed.map(f => f.component)).toEqual(['lark-cli']);
    expect(state.profileConfig.mode).toBe('personal');
    expect(state.profileConfig.permissions.defaultAccess).toBe('read-only');
    expect(execution.updateProfile.mock.calls.at(-1)![0]).toMatchObject({ mode: 'personal', permissions: { defaultAccess: 'read-only' } });
  });
});
