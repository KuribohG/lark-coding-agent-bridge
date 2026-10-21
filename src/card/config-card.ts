import { reasoningEffortOptions } from '../agent/model-settings';
import { modelLabel, type ModelOption } from '../agent/models';
import { AGENT_OPTIONS } from '../agent/backends';
import type { KnownChat } from '../bot/lark-info';
import type { AgentKind, LarkCliIdentityPreset, ProfileMode } from '../config/profile-schema';
import type { CotMessagesMode, MessageReplyMode } from '../config/schema';

export interface ConfigFormOpts {
  section?: 'run' | 'lark' | 'access';
  revision?: string;
  /** Profile's agent kind — decides which model catalog the picker shows. */
  agentKind: AgentKind;
  /** Deployment mode: 'personal' (default) or 'team'. */
  mode: ProfileMode;
  /** Current model ID, including a custom provider identifier. */
  model: string;
  reasoningEffort?: string;
  models?: ModelOption[];
  messageReply: MessageReplyMode;
  showToolCalls: boolean;
  cotMessages: CotMessagesMode;
  maxConcurrentRuns: number;
  /** 0 means "disabled". */
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  larkCliIdentity: LarkCliIdentityPreset;
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  knownChats: KnownChat[];
  /** URL of the running local web console (supervisor `--web-ui` mode). Shown
   * at the top of the card when present; omitted when no console is running. */
  consoleUrl?: string;
  /** The saved run settings also changed the profile's execution backend. */
  agentSwitched?: boolean;
  scopeAgentSwitched?: boolean;
}

/** Form card for `/config`. */
export function configFormCard(opts: ConfigFormOpts): object {
  const section = opts.section ?? 'run';
  const elements: object[] = [];
  const note = (content: string) => elements.push({ tag: 'markdown', content });
  const input = (name: string, label: string, value: string) => {
    note(label); elements.push({ tag: 'input', name, default_value: value });
  };
  const select = (name: string, label: string, value: string, options: [string, string][]) => {
    note(label); elements.push({ tag: 'select_static', name, initial_option: value,
      options: options.map(([value, content]) => ({ value, text: { tag: 'plain_text', content } })) });
  };
  if (section === 'run') {
    select('agent_kind', '**执行引擎（当前上下文）**', opts.agentKind,
      AGENT_OPTIONS.map(({ value, label }) => [value, label]));
    note('仅修改当前聊天/话题；下一条消息使用新引擎。Profile 默认引擎在本地网页配置页修改。');
    input('model', '**Profile 默认模型**（当前上下文请用 `/model`）', opts.model);
    select('reasoning_effort', '**思考强度**', opts.reasoningEffort ?? 'default',
      reasoningEffortOptions(opts.agentKind).map(({ value, label }) => [value, label]));
    input('max_concurrent_runs', '**此 bot 并发上限**（1–50，inherit 恢复继承）', String(opts.maxConcurrentRuns));
    input('run_idle_timeout_minutes', '**无输出超时**（分钟，0 关闭，inherit 恢复继承）', String(opts.runIdleTimeoutMinutes));
  } else if (section === 'lark') {
    note('以下设置只影响飞书展示，不影响模型推理和 Web 聊天。');
    select('message_reply', '**回复形式**', opts.messageReply,
      [['inherit', '继承飞书默认'], ['markdown', '流式消息卡片'], ['text', '完成后发送文本'], ['card', '交互卡片']]);
    select('show_tool_calls', '**工具过程**', opts.showToolCalls ? 'show' : 'hide', [['inherit', '继承飞书默认'], ['show', '显示'], ['hide', '隐藏']]);
    select('cot_messages', '**飞书过程消息**', opts.cotMessages, [['inherit', '继承飞书默认'], ['off', '关闭'], ['brief', '简略'], ['detailed', '详细']]);
  } else {
    select('deploy_mode', '**使用模式**', opts.mode, [['personal', '个人'], ['team', '团队']]);
    note('团队模式允许任何人 @ 使用，并强制只使用应用身份；管理命令仍限 owner/管理员。');
    select('require_mention_in_group', '**群里需要 @**', opts.requireMentionInGroup ? 'yes' : 'no', [['yes', '需要'], ['no', '不需要']]);
    select('lark_cli_identity', '**飞书身份策略**', opts.larkCliIdentity, [['bot-only', '应用身份'], ['user-default', '允许已授权用户身份']]);
    note(`允许私聊：${opts.allowedUsers.length} 人；响应群：${opts.allowedChats.length} 个；管理员：${opts.admins.length} 人。\n使用 /invite 和 /remove 管理名单。`);
  }
  elements.push({ tag: 'button', name: 'submit_btn', type: 'primary', form_action_type: 'submit',
    text: { tag: 'plain_text', content: '保存' }, behaviors: [{ type: 'callback', value: { cmd: 'config.submit', revision: opts.revision, section } }] });
  elements.push({ tag: 'button', name: 'cancel_btn', text: { tag: 'plain_text', content: '取消' },
    behaviors: [{ type: 'callback', value: { cmd: 'config.cancel' } }] });
  return { schema: '2.0', config: { summary: { content: '配置' } }, body: { elements: [
    { tag: 'markdown', content: `**${section === 'run' ? '执行配置' : section === 'lark' ? '飞书展示' : '访问与账号'}**` },
    ...(opts.consoleUrl ? [{ tag: 'markdown', content: `[Web 控制台](${opts.consoleUrl})` }] : []),
    { tag: 'form', name: 'config_form', elements },
  ] } };
}

export function configSavedCard(opts: ConfigFormOpts): object {
  const details = opts.section === 'lark'
    ? [`回复形式：${opts.messageReply}`, `工具过程：${opts.showToolCalls ? '显示' : '隐藏'}`, `过程消息：${cotMessagesLabel(opts.cotMessages)}`]
    : opts.section === 'access'
      ? [`使用模式：${opts.mode === 'team' ? '团队' : '个人'}`, `群里需要 @：${opts.requireMentionInGroup ? '是' : '否'}`, `身份策略：${opts.mode === 'team' || opts.larkCliIdentity === 'bot-only' ? '应用身份' : '允许已授权用户身份'}`]
      : [`执行引擎：${AGENT_OPTIONS.find((item) => item.value === opts.agentKind)?.label ?? opts.agentKind}`, `模型：${modelLabel(opts.agentKind, opts.model)}`, `思考强度：${opts.reasoningEffort ?? 'CLI 默认'}`, `并发上限：${opts.maxConcurrentRuns}`, `无输出超时：${opts.runIdleTimeoutMinutes ? `${opts.runIdleTimeoutMinutes} 分钟` : '关闭'}`];
  return { schema: '2.0', config: { summary: { content: '偏好已保存' } }, body: { elements: [
    { tag: 'markdown', content: '✅ **偏好已保存**\n\n' + details.join('\n') + '\n\n' +
      (opts.scopeAgentSwitched
        ? '当前聊天/话题的执行引擎已切换；从下一条消息开始使用新引擎，飞书通道无需重连。'
        : opts.agentSwitched
          ? '此 profile 正在切换执行引擎并重连飞书通道；稍后直接发送消息即可。'
        : '下条消息开始生效。完整设置见 /config。') },
  ] } };
}

function cotMessagesLabel(value: CotMessagesMode): string {
  if (value === 'brief') return '简略';
  if (value === 'detailed') return '详细';
  return '关闭';
}

/**
 * Shown after `/config` saves "群里不需要 @ bot" but the app is missing the
 * `im:message.group_msg` scope. Guides the user through one-click incremental
 * authorization via the link from `requestScopeGrantLink`.
 */
export function groupMsgScopeGrantCard(url: string, expireMins: number): object {
  return {
    schema: '2.0',
    config: { summary: { content: '需要补授权' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚠️ **「群里不需要 @ bot」还差一个权限**\n\n' +
            '你已开启「不 @ bot 也回复」，但当前应用没有 **获取群组中所有消息**（`im:message.group_msg`）权限。' +
            '没有它，飞书不会把群里非 @ 的消息推给 bot，所以这个设置暂时不生效。\n\n' +
            `**点下面的链接补授权**（约 ${expireMins} 分钟内有效）：\n` +
            `[🔗 点此一键授权](${url})\n\n` +
            '_扫码/点击后会进入确认页，新权限已预填好，确认即可。授权成功后，群里新消息开始自动生效，无需重启。_\n' +
            `_若链接打不开，可复制：_\n\`${url}\`\n\n` +
            '_授权后若群里仍收不到非 @ 消息，发 `/reconnect` 重连一次即可。_',
        },
      ],
    },
  };
}

/** Replaces {@link groupMsgScopeGrantCard} in place once authorization completes. */
export function groupMsgScopeGrantedCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '授权成功' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **授权成功**\n\n' +
            '`im:message.group_msg` 权限已生效，群里非 @ bot 的消息从现在开始会触发回复。\n\n' +
            '_若仍未生效，发 `/reconnect` 重连一次。_',
        },
      ],
    },
  };
}

export function configCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消,未做任何修改。' }],
    },
  };
}

export function configFailedCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '保存失败' } },
    body: {
      elements: [{ tag: 'markdown', content: `保存失败：${reason}` }],
    },
  };
}
