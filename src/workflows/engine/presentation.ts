import type { WorkflowState } from './types';

export function renderWorkflowPlan(state: WorkflowState, plan: string): string {
  const main = state.root.modelSettings;
  const defaults = state.script!.defaults;
  return [
    `执行方案：${state.script!.name}（第 ${state.script!.revision + 1} 轮）`,
    `主 agent：${state.root.agentKind} / ${main.model ?? '默认模型'}${main.reasoningEffort ? ` / ${main.reasoningEffort}` : ''}`,
    `worker 默认：${defaults.agentKind} / ${defaults.model ?? (defaults.agentKind === state.root.agentKind ? main.model : undefined) ?? '目标默认模型'}${defaults.reasoningEffort ? ` / ${defaults.reasoningEffort}` : ''}`,
    '', plan, '',
    '用 /workflow plan 再次查看方案，/workflow status 查看实际执行进度。',
  ].join('\n');
}
