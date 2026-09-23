import type { ModelEnvironment } from '../agent/model-settings';
import { availableEfforts } from '../agent/model-settings';
import type { AgentKind } from '../config/profile-schema';
import { formatRunTime } from '../runtime/run-deadline';
import type { TimedRun } from '../runtime/timed-runs';
import type { RunDefaults } from '../runtime/run-defaults';

export function timedRunForm(scope: string, agentKind: AgentKind, environment: ModelEnvironment, defaults: RunDefaults, editDefaults = false): object {
  const models = environment.models.filter((model) => model.value !== 'default').slice(0, 80);
  const modelPick = defaults.model
    ? models.some((model) => model.value === defaults.model) ? defaults.model : '__manual__'
    : 'default';
  return {
    schema: '2.0', config: { summary: { content: '一次性限时任务' } },
    header: { title: { tag: 'plain_text', content: editDefaults ? '⏱ 此 bot 的限时任务默认值' : '⏱ 一次性限时任务' }, template: 'blue' },
    body: { elements: [
      { tag: 'markdown', content: editDefaults
        ? '仅 owner/管理员可保存。作用于此 bot 下新建的 /run 任务，不修改普通聊天的模型/强度。\n每次运行重新计算截止日期，已创建的任务不变；发送 `/run 具体任务` 即可使用。'
        : '使用当前话题/聊天的上下文。模型和强度只覆盖这次任务；提交后先核对具体停止时间，再点击启动。\n已填入此 bot 的 /run 默认值，修改仅影响本次；用 `/run defaults` 修改默认值。\n到期、出错或额度耗尽后不自动续跑。服务端已接收请求的计费以服务商规则为准。' },
      { tag: 'form', name: 'timed_run', elements: [
        ...(!editDefaults ? [{ tag: 'markdown', content: '**任务目标 / 任务列表**' },
        { tag: 'input', name: 'task', input_type: 'multiline_text', required: true,
          placeholder: { tag: 'plain_text', content: '请描述要完成的工作；完成后提前结束。' } }] : []),
        { tag: 'markdown', content: '**截止时间**：01:00 表示下一次凌晨一点；也可填写 2h、90m。' + (editDefaults ? '默认值不能保存固定日期。' : '本次也可填写带时区的完整日期。') },
        { tag: 'input', name: 'until', default_value: defaults.until, required: true },
        { tag: 'markdown', content: '**时区**（01:00 等钟点按此时区解释）' },
        { tag: 'input', name: 'time_zone', default_value: defaults.timeZone, required: true },
        { tag: 'markdown', content: '**提前停止的安全余量（分钟）**：收尾也计入时间窗口。' },
        { tag: 'input', name: 'margin', default_value: String(defaults.marginMinutes) },
        { tag: 'markdown', content: editDefaults ? '**限时任务默认模型**' : '**本次模型**' },
        { tag: 'select_static', name: 'model_pick', initial_option: modelPick, options: [
          { text: { tag: 'plain_text', content: '沿用当前对话设置' }, value: 'default' },
          { text: { tag: 'plain_text', content: '使用下方手填模型名' }, value: '__manual__' },
          ...models.map((m) => ({
            text: { tag: 'plain_text', content: m.label }, value: m.value,
          })),
        ] },
        { tag: 'input', name: 'model', default_value: defaults.model ?? '', placeholder: { tag: 'plain_text', content: 'provider/model' } },
        { tag: 'markdown', content: editDefaults ? '**限时任务默认思考强度**' : '**本次思考强度**' },
        { tag: 'select_static', name: 'effort', initial_option: defaults.reasoningEffort ?? 'default', options:
          ['default', ...availableEfforts(agentKind)].map((value) => ({
            text: { tag: 'plain_text', content: value === 'default' ? '沿用当前对话设置' : value }, value,
          })),
        },
        { tag: 'button', name: 'preview', type: 'primary', form_action_type: 'submit',
          text: { tag: 'plain_text', content: editDefaults ? '保存为此 bot 的 /run 默认值' : '核对任务与停止时间' },
          behaviors: [{ type: 'callback', value: { cmd: editDefaults ? 'run.defaults.save' : 'run.submit', settings_scope: scope, agent_kind: agentKind } }],
        },
      ] },
    ] },
  };
}

const labels = {
  draft: '待确认', queued: '排队中', running: '运行中', completed: '已完成', stopped: '已停止',
  expired: '已到停止时间', quota: '额度不足，已停止', failed: '执行失败', interrupted: '重启后已停止',
};

export function timedRunCard(job: TimedRun, now = Date.now()): object {
  const expired = job.stopAt <= now && ['draft', 'queued', 'running'].includes(job.state);
  const button = (text: string, cmd: string) => ({
    tag: 'button', text: { tag: 'plain_text', content: text },
    behaviors: [{ type: 'callback', value: { cmd, arg: job.id, settings_scope: job.scope } }],
  });
  return {
    schema: '2.0', config: { summary: { content: '限时任务状态' } },
    body: { elements: [
      { tag: 'markdown', content: `**限时任务：${expired ? labels.expired : labels[job.state]}**\n` +
        `任务：${job.task}\n\n模型：\`${job.modelSettings.model ?? 'CLI 默认'}\`\n思考强度：\`${job.modelSettings.reasoningEffort ?? 'CLI 默认'}\`\n` +
        `额度 / 任务截止：**${formatRunTime(job.deadlineAt, job.timeZone)}**\n` +
        `建议开始收尾：${formatRunTime(job.windDownAt, job.timeZone)}\n` +
        `强制停止：**${formatRunTime(job.stopAt, job.timeZone)}**\n\n` +
        '仅本次任务生效。到期和重启后不自动续跑；手动继续需重新设置时间。强制停止可能中断未完成的工具操作，请让任务定期保存成果。' },
      ...(!expired && job.state === 'draft' ? [button('确认并启动', 'run.start')] : []),
      ...(['draft', 'queued', 'running'].includes(job.state) ? [button('取消 / 停止', 'run.stop')] : []),
      button('刷新状态', 'run.status'),
    ] },
  };
}
