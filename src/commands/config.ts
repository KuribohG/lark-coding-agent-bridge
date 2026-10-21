import { inspectConfig, reloadProfile, readProfileSnapshot } from '../config/service';
import {
  applyPreferencesChange,
  preparePreferencesChange,
  PreferencesApplyError,
  type PreferencesChange,
} from '../config/preferences';
import { modelEnvironment } from '../runtime/model-settings';
import { capabilityForProfile, isAgentKind } from '../agent/backends';
import { profileForAgentKind } from '../runtime/agent-runtime';
import { normalizeModelSelection } from '../agent/models';
import {
  configCancelledCard,
  configFailedCard,
  configFormCard,
  configSavedCard,
  groupMsgScopeGrantCard,
  groupMsgScopeGrantedCard,
} from '../card/config-card';
import { GROUP_MSG_SCOPE, hasGroupMsgScope } from '../bot/app-scope';
import { requestScopeGrantLink } from '../bot/wizard';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import {
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
} from '../config/schema';
import { log, reportMetric } from '../core/logger';
import { isAlive } from '../runtime/registry';
import { readUiSidecar } from '../ui/sidecar';
import { fetchKnownChats } from '../bot/lark-info';
import type { CommandContext } from './types';
import { reply, recallMessage, commandReplyOptions, FORM_SETTLE_MS } from './presentation';
import { commandProfilePaths } from './context';

// ────────────── /config — preferences form ──────────────

export async function handleConfig(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
    case 'show':
      return showConfigSummary(ctx, sub === 'show' ? args.trim().split(/\s+/)[1] : undefined);
    case 'run':
    case 'lark':
    case 'access':
      return showConfigForm(ctx, sub);
    case 'reload': {
      const result = await reloadProfile(ctx.controls);
      await reply(ctx, `${result.applied.length ? '执行与展示设置已重新加载，下一轮任务采用。' : 'agent 类型已修改，重启后加载。'}${result.restart.length ? `仍需重启的配置：${result.restart.join(', ')}` : ''}`);
      return;
    }
    case 'submit':
      return submitConfig(ctx);
    case 'cancel':
      return cancelConfig(ctx);
    default:
      await reply(ctx, '用法：`/config`、`/config run`、`/config lark`、`/config access`、`/config reload`');
  }
}

async function showConfigSummary(ctx: CommandContext, path?: string): Promise<void> {
  const view = await inspectConfig(ctx.controls.configPath, ctx.controls.profile);
  const summary = (label: string, values: Record<string, { value: unknown; source: string }>) =>
    `**${label}**\n` + Object.entries(values).map(([key, entry]) => `- ${key}: ${String(entry.value)}（${entry.source}）`).join('\n');
  const selected = path === 'run' ? summary('执行', view.run) : path === 'lark' || path === 'web'
    ? summary(path === 'lark' ? '飞书展示' : 'Web 展示', view.channels[path]!)
    : [summary('执行', view.run), summary('飞书展示', view.channels.lark!)].join('\n\n');
  const activeAgent = ctx.agentKind ?? view.agent;
  await reply(ctx, `**${view.profile} · 默认 ${view.agent} · 当前上下文 ${activeAgent}**\n配置文件：${view.file}\n\n${selected}\n\n` +
    '以上为文件中的 profile 默认值；当前会话覆盖用 /model 查看。\n' +
    '修改：/config run · /config lark · /config access\n手工编辑后：/config reload（启动参数变化需重启）。');
}

async function showConfigForm(ctx: CommandContext, section: 'run' | 'lark' | 'access'): Promise<void> {
  await Promise.all([
    ctx.controls.refreshOwner(ctx.channel).catch(() => {}),
    fetchKnownChats(ctx.channel)
      .then((chats) => {
        if (chats.length > 0) ctx.controls.knownChats = chats;
      })
      .catch(() => {}),
  ]);

  const snapshot = await readProfileSnapshot(ctx.controls);
  const view = snapshot.state;
  const ms = getRunIdleTimeoutMs(view.cfg);
  const access = view.profileConfig.access;
  // Surface the local web console URL when the supervisor (`--web-ui`) is
  // running — read from the host sidecar and confirm the owning process is
  // alive so we don't advertise a stale address.
  const sidecar = await readUiSidecar(commandProfilePaths(ctx).hostUiFile).catch(() => undefined);
  const consoleUrl = sidecar && isAlive(sidecar.pid) ? sidecar.url : undefined;
  const agentKind = ctx.agentKind ?? view.profileConfig.agentKind;
  const environment = section === 'run' ? await modelEnvironment(view, agentKind) : { models: [] };
  const card = configFormCard({
    section,
    revision: snapshot.revision,
    models: environment.models,
    reasoningEffort: view.cfg.preferences?.reasoningEffort,
    agentKind,
    mode: view.profileConfig.mode,
    model: normalizeModelSelection(
      agentKind,
      view.cfg.preferences?.model,
    ),
    messageReply: getMessageReplyMode(view.cfg),
    showToolCalls: getShowToolCalls(view.cfg),
    cotMessages: getCotMessages(view.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(view.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(view.cfg),
    larkCliIdentity: view.profileConfig.larkCli.identityPreset,
    allowedUsers: access.allowedUsers,
    allowedChats: access.allowedChats,
    admins: access.admins,
    knownChats: ctx.controls.knownChats ?? [],
    ...(consoleUrl ? { consoleUrl } : {}),
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

async function showResultCardInPlace(
  ctx: CommandContext,
  formMsgId: string,
  card: object,
): Promise<void> {
  try {
    await updateManagedCard(ctx.channel, formMsgId, card);
  } catch (err) {
    log.warn('command', 'config-card-update-fallback', { err: String(err) });
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx)).catch((fallbackErr) =>
      log.warn('command', 'config-card-fallback-send-failed', {
        err: String(fallbackErr),
      }),
    );
  }
  forgetManagedCard(formMsgId);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await showResultCardInPlace(ctx, formMsgId, configCancelledCard());
    })();
  }
}

/** Translate the short form into a sparse settings patch. */
function configFormPatch(
  fv: Record<string, unknown>,
): Record<string, unknown> {
  const text = (key: string) => String(fv[key] ?? '').trim();
  const picked = fv.model_pick;
  const rawModel = picked && picked !== '__manual__' ? String(picked) : fv.model;
  const maxConcurrentRuns = Number(text('max_concurrent_runs'));
  const mention = text('require_mention_in_group');
  const patch: Record<string, unknown> = {};
  if (rawModel !== undefined) patch.model = String(rawModel).trim();
  if (fv.reasoning_effort !== undefined) patch.reasoningEffort = fv.reasoning_effort;
  if (fv.message_reply !== undefined) patch.messageReply = text('message_reply');
  if (fv.show_tool_calls !== undefined) patch.showToolCalls = text('show_tool_calls') !== 'hide';
  if (fv.cot_messages !== undefined) patch.cotMessages = text('cot_messages') === 'on' ? 'detailed' : text('cot_messages');
  if (fv.max_concurrent_runs !== undefined) patch.maxConcurrentRuns = Number.isFinite(maxConcurrentRuns) && maxConcurrentRuns >= 1 ? maxConcurrentRuns : undefined;
  if (fv.run_idle_timeout_minutes !== undefined) patch.runIdleTimeoutMinutes = text('run_idle_timeout_minutes') || undefined;
  if (fv.require_mention_in_group !== undefined) patch.requireMentionInGroup = mention === 'yes' ? true : mention === 'no' ? false : undefined;
  if (fv.deploy_mode !== undefined) patch.mode = text('deploy_mode');
  if (fv.lark_cli_identity !== undefined) patch.larkCliIdentity = text('lark_cli_identity');
  const inherit: string[] = [];
  const fields: Record<string, string> = { message_reply: 'messageReply', show_tool_calls: 'showToolCalls', cot_messages: 'cotMessages', max_concurrent_runs: 'maxConcurrentRuns', run_idle_timeout_minutes: 'runIdleTimeoutMinutes' };
  for (const [field, key] of Object.entries(fields)) if (text(field) === 'inherit') {
    inherit.push(key); delete patch[key];
  }
  if (inherit.length) patch.inheritSettings = inherit;
  if (fv.config_revision !== undefined) patch.configRevision = fv.config_revision;
  return patch;
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  let change: PreferencesChange;
  const requestedAgentKind = String(ctx.formValue?.agent_kind ?? '').trim();
  const currentAgentKind = ctx.agentKind ?? ctx.controls.profileConfig.agentKind;
  if (requestedAgentKind && !isAgentKind(requestedAgentKind)) {
    await reply(ctx, '设置未保存：未知执行引擎。');
    return;
  }
  const nextAgentKind = requestedAgentKind && isAgentKind(requestedAgentKind)
    ? requestedAgentKind
    : currentAgentKind;
  const scopeAgentChanged = nextAgentKind !== currentAgentKind;
  const scopedProfile = profileForAgentKind(ctx.controls.profileConfig, nextAgentKind);
  const capability = capabilityForProfile(scopedProfile);
  if (
    scopeAgentChanged &&
    capability.permissions.supportedAccess &&
    !capability.permissions.supportedAccess.includes(ctx.controls.profileConfig.permissions.defaultAccess)
  ) {
    await reply(ctx, `设置未保存：${nextAgentKind} 不支持当前的 ${ctx.controls.profileConfig.permissions.defaultAccess} 权限。`);
    return;
  }
  const patch = configFormPatch(ctx.formValue ?? {});
  if (scopeAgentChanged) {
    delete patch.model;
    delete patch.reasoningEffort;
  }
  try {
    change = await preparePreferencesChange(ctx.controls, patch);
  } catch (err) {
    await reply(ctx, `设置未保存：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const { mode, larkCliIdentity, requireMentionInGroup } = change;

  const formMsgId = ctx.msg.messageId;

  // Detach: same reason as account submit — Lark's client locks the form
  // while the cardAction handler is running. Wait out FORM_SETTLE_MS *after*
  // returning so the in-place card update sticks.
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    try {
      await applyPreferencesChange(ctx.controls, change);
      if (scopeAgentChanged) {
        if (!ctx.setAgentKind) throw new Error('当前运行入口不支持按上下文切换执行引擎。');
        await ctx.setAgentKind(ctx.scope, nextAgentKind);
      }
    } catch (err) {
      const failureStep = err instanceof PreferencesApplyError ? err.step : 'config.save';
      const rollbackFailed = err instanceof PreferencesApplyError && err.rollbackFailed;
      const larkCliPolicyApplied = err instanceof PreferencesApplyError && err.identityApplied;
      if (rollbackFailed) log.warn('command', 'lark-cli-identity-policy-rollback-failed', { profile: ctx.controls.profile });
      log.fail('command', err, { step: failureStep });
      reportMetric('command_fail', 1, { step: failureStep });
      await waitForSettle();
      await showResultCardInPlace(
        ctx,
        formMsgId,
        configFailedCard(configFailureMessage(failureStep, rollbackFailed, larkCliPolicyApplied)),
      );
      return;
    }

    const saved = ctx.controls.profileConfig;
    const agentKind = nextAgentKind;
    const modelSelection = scopeAgentChanged
      ? 'default'
      : normalizeModelSelection(agentKind, saved.preferences.model);
    const reasoningEffort = scopeAgentChanged ? undefined : saved.preferences.reasoningEffort;
    const messageReply = getMessageReplyMode(saved);
    const showToolCalls = getShowToolCalls(saved);
    const cotMessages = getCotMessages(saved);
    const maxConcurrentRuns = getMaxConcurrentRuns(saved);
    const runIdleTimeoutMinutes = (getRunIdleTimeoutMs(saved) ?? 0) / 60000;
    const access = saved.access;
    log.info('command', 'config-saved', {
      mode,
      agentKind,
      messageReply,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      larkCliIdentity,
      allowedUsersCount: access.allowedUsers.length,
      allowedChatsCount: access.allowedChats.length,
      adminsCount: access.admins.length,
    });
    await waitForSettle();
    await showResultCardInPlace(
      ctx,
      formMsgId,
      configSavedCard({
        section: ctx.formValue?.config_section === 'lark' ? 'lark' : ctx.formValue?.config_section === 'access' ? 'access' : 'run',
        agentKind,
        mode,
        model: modelSelection,
        reasoningEffort,
        messageReply,
        showToolCalls,
        cotMessages,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        larkCliIdentity,
        scopeAgentSwitched: scopeAgentChanged,
        allowedUsers: access.allowedUsers,
        allowedChats: access.allowedChats,
        admins: access.admins,
        knownChats: ctx.controls.knownChats ?? [],
      }),
    );
    // "群里不需要 @ bot" only works if the app can actually receive non-@
    // group messages (`im:message.group_msg`). When the user opts in, verify
    // the scope and, if missing, push a one-click re-authorization link.
    if (!requireMentionInGroup) {
      await promptGroupMsgScopeIfMissing(ctx);
    }
  })();
}

/**
 * When the user enables "群里不需要 @ bot", confirm the app holds the
 * `im:message.group_msg` scope. If it's missing, generate an incremental
 * authorization link and push a guidance card; once the user finishes
 * authorizing, swap the card to a success state in place. Best-effort — any
 * failure here is logged and swallowed (the saved-config card already showed).
 */
async function promptGroupMsgScopeIfMissing(ctx: CommandContext): Promise<void> {
  const appId = ctx.controls.cfg.accounts.app.id;
  // `false` = confirmed missing; `null` = lookup failed → don't nag.
  const has = await hasGroupMsgScope(ctx.channel, appId);
  if (has !== false) return;
  log.info('command', 'group-msg-scope-missing', { appId });

  let link;
  try {
    link = await requestScopeGrantLink({ appId, tenantScopes: [GROUP_MSG_SCOPE] });
  } catch (err) {
    log.warn('command', 'scope-grant-link-failed', { err: String(err) });
    return;
  }

  const expireMins = Math.max(1, Math.round(link.expireIn / 60));
  let sent;
  try {
    sent = await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      groupMsgScopeGrantCard(link.url, expireMins),
    );
  } catch (err) {
    log.warn('command', 'scope-grant-card-send-failed', { err: String(err) });
    return;
  }

  // Detached: flip the card to "授权成功" once the user authorizes (or just
  // clean up the managed-card mapping if the link expires / is aborted).
  void link.completion.then(
    async () => {
      log.info('command', 'group-msg-scope-granted', { appId });
      await updateManagedCard(ctx.channel, sent.messageId, groupMsgScopeGrantedCard()).catch(
        () => {},
      );
      forgetManagedCard(sent.messageId);
    },
    (err) => {
      log.info('command', 'scope-grant-not-completed', { err: String(err) });
      forgetManagedCard(sent.messageId);
    },
  );
}

function configFailureMessage(step: string, rollbackFailed: boolean, larkCliPolicyApplied: boolean): string {
  if (rollbackFailed) {
    return '保存失败，且 lark-cli 身份策略回滚失败。请执行 /status 检查当前状态。';
  }
  if (larkCliPolicyApplied && step === 'config.save') {
    return '保存失败，lark-cli 身份策略已回滚。请重新打开 /config 确认当前状态。';
  }
  if (step === 'config.lark-cli-policy') {
    return 'lark-cli 身份策略未生效，未做任何修改。';
  }
  return '配置未写入，未做任何修改。';
}
