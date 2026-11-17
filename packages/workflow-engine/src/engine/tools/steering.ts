import { CHARTER_MAX_TEXT, WAKE_MAX_MINUTES, setCharter, setMainWake } from '../steering';
import { setMemberTimer } from '../swarm';
import { memberOperation } from './members';
import type { WorkflowToolPlugin } from './types';
import { versioned } from './versioned';

/** Keeping long-running work on course: the charter that carries the current goal, and wake-ups that do not depend on a post. */
export const steeringTools: WorkflowToolPlugin = {
  id: 'steering',
  memberInstructions: `目标单是本工作流现行的目标、优先级和长期规则，每一轮的提示里都带着现行版本（read_context 的 charter 字段同样给出，changed 表示自你上一轮以来有更新）：它与“需求”、任务说明或更早的公告不一致时以它为准。只有主 agent 和 swarm 的 lead 能改：set_charter({operationId,text}) 用 text（最多 ${CHARTER_MAX_TEXT} 字符）整份替换，写清目标、可检验的完成标准、优先级、不做什么和口径；方向、优先级或口径变了就改它，不要只发公告。`
    + `wake_me({operationId,afterMinutes,note?}) 让 swarm 成员在 afterMinutes 分钟（1–${WAKE_MAX_MINUTES}）后被唤醒一轮，不需要任何人点名：等待耗时的构建、测试、排队或要定期复查时，先保存 checkpoint、设好它再结束本轮，不要占着本轮轮询或睡眠。每名成员只有一个定时，再次调用即替换，afterMinutes 为 0 取消；被帖子或新工作提前唤醒时定时仍保留；它与被点名一样计入唤醒次数。`,
  tools: [
    {
      name: 'set_charter',
      main: { doc: 'set_charter(text)', ...versioned((ctx, state, args) => setCharter(state, args, 'main', ctx.now()), { allowInterrupted: true, appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'set_charter', args, agent => setCharter(state, args, agent.key, ctx.now())) },
    },
    {
      name: 'wake_me',
      main: { doc: 'wake_me(afterMinutes?,everyMinutes?,note?)', ...versioned((ctx, state, args) => setMainWake(state, args, ctx.now()), { appendOnly: true }) },
      worker: { verifiesRoot: true,
        call: (ctx, state, task, _caller, args) => memberOperation(ctx, state, task, 'wake_me', args, agent => setMemberTimer(state, agent.key, args, ctx.now())) },
    },
  ],
};
