import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowKernel } from '../src/engine/kernel';
import { handleWorkflowCommand } from '../src/chat/commands';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from '../src/engine/types';
import { renderWorkflowProgress, renderWorkflowStatus } from '../src/chat/status';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture(execute: (request: WorkflowWorkerRequest) => Promise<WorkflowWorkerResult> = async () => ({ status: 'failed' })) {
  const root: WorkflowRoot = {scopeId:'topic',profile:'default',agentKind:'codex',cwdRealpath:'/workspace',
    policyFingerprint:'policy',catalogBinding:'root',modelSettings:{model:'main-model',reasoningEffort:'high'}};
  const kernel = new WorkflowKernel(':memory:', {resolveRoot:async()=>root,wakeMain:async()=>{},execute,
    resolveWorker:async(current,selection)=>({agentKind:selection.agentKind,profile:current.profile,configurationFingerprint:'config',policyFingerprint:'policy',
      modelSettings:{model:selection.model,reasoningEffort:selection.reasoningEffort}})});
  cleanup.push(()=>kernel.close());
  const submit = vi.fn<(_: string) => string | undefined>(()=>undefined);
  const command = (args: string) => handleWorkflowCommand(kernel,'topic',args,submit,{sanitize:text=>text.replace(/Bearer\s+\S+/g,'Bearer [REDACTED]')});
  const start = async () => kernel.call({kind:'main',scopeId:'topic',allowStart:true},'run_script',{operationId:randomUUID(),goal:'review',plan:'Pi with service/worker-model reviews the design and returns findings.',script:'return null;'});
  return {kernel,root,submit,command,start};
}

describe('Lark workflow commands', () => {
  it.each(['start', 'script'])('routes %s through the same script API with model requirements preserved', async operation => {
    const f=fixture();
    expect(await f.command(operation+' 架构评审：Pi 用 service/model-a；Codex 用 model-b')).toBeUndefined();
    const text=f.submit.mock.calls[0]![0];
    expect(text).toContain('run_script'); expect(text).toContain('service/model-a'); expect(text).toContain('model-b');
    expect(text).toContain('主 agent 沿用当前会话'); expect(text).not.toContain('architecture-review');
  });
  it('shows usage, prevents duplicate starts and propagates queue rejection', async () => {
    const f=fixture(); expect(await f.command('start')).toContain('用法'); expect(f.submit).not.toHaveBeenCalled();
    f.submit.mockReturnValueOnce('消息队列已满'); expect(await f.command('start task')).toBe('消息队列已满');
    await f.start(); expect(await f.command('start another')).toContain('已绑定'); expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it('shows the selected main and worker models and applies pause/resume/cancel', async () => {
    const f=fixture(); await f.start(); const state=f.kernel.state('topic')!;
    f.kernel.beginScript('topic',state.workflowId);
    await f.kernel.scriptAgent('topic',state.workflowId,state.script!.runId,{key:'review',prompt:'review',harness:'pi',model:'service/worker-model',reasoningEffort:'minimal'});
    expect(await f.command('plan')).toContain('Pi with service/worker-model reviews');
    const status=await f.command('status');
    expect(status).toContain('codex，模型：main-model，思考强度：high');
    expect(status).toContain('pi，模型：service/worker-model，思考强度：minimal');
    expect(await f.command('pause')).toContain('取消在途任务'); expect(f.kernel.state('topic')?.script?.status).toBe('paused');
    expect(await f.command('resume')).toContain('重放'); expect(f.kernel.state('topic')?.script?.revision).toBe(1);
    expect(await f.command('cancel')).toContain('已请求取消'); expect(await f.command('status')).toContain('cancelled（最近一次）');
    expect(await f.command('plan')).toContain('Pi with service/worker-model reviews');
  });

  it('shows running, failed and interrupted turns with saved recovery points without exposing checkpoint contents', async () => {
    let request: WorkflowWorkerRequest | undefined;
    const f = fixture(async current => {
      request = current;
      current.onRun('run-1'); current.onSession('native-thread');
      return new Promise(resolve => current.signal.addEventListener('abort', () => resolve({ status: 'completed', text: 'late' }), { once: true }));
    });
    await f.start();
    const state = f.kernel.state('topic')!;
    f.kernel.beginScript('topic', state.workflowId);
    await f.kernel.scriptAgent('topic', state.workflowId, state.script!.runId, { key: 'design', member: 'A', prompt: 'Design a cache' });
    expect(await f.command('status A')).toContain('排队');
    await f.kernel.tick();
    await vi.waitFor(() => expect(request).toBeDefined());
    await f.kernel.call({ kind: 'worker', scopeId: 'topic', workflowId: state.workflowId, taskId: request!.task.taskId, attemptId: request!.attemptId },
      'checkpoint', { operationId: 'save', expectedCheckpointVersion: 0, state: { internal: 'private-checkpoint-text' } });
    const version = f.kernel.state('topic')!.stateVersion;
    const running = await f.command('status A');
    expect(running).toContain('成员 A：执行中');
    expect(running).toContain('任务：design，尝试 1 次');
    expect(running).toContain('恢复点：#1');
    expect(running).toContain('UTC（执行中保存）');
    expect(running).not.toContain('private-checkpoint-text');
    expect(f.kernel.state('topic')!.stateVersion).toBe(version);
    await f.command('pause');
    await vi.waitFor(() => expect(f.kernel.state('topic')!.tasks[0]!.status).toBe('cancelled'));
    const paused = await f.command('status A');
    expect(paused).toContain('成员 A：已取消');
    expect(paused).toContain('/workflow resume');
    expect(paused).toContain('恢复点：#1');
    expect(paused).not.toContain('成员 A：执行中');
  });

  it('distinguishes waiting, reserved messages and completed inputs across member turns', async () => {
    const f = fixture(async request => { request.onSession('native-thread'); return { status: 'completed', text: 'ready' }; });
    await f.start();
    const state = f.kernel.state('topic')!;
    f.kernel.beginScript('topic', state.workflowId);
    const agent = (key: string) => f.kernel.scriptAgent('topic', state.workflowId, state.script!.runId, { key, member: 'A', prompt: key });
    const completeTurn = async () => {
      await f.kernel.tick();
      await vi.waitFor(() => expect(f.kernel.state('topic')!.tasks.at(-1)!.status).toBe('result_ready'));
    };
    await agent('proposal'); await completeTurn();
    await f.kernel.scriptMailbox('topic', state.workflowId, state.script!.runId, { kind: 'receive', member: 'A', key: 'feedback' });
    expect(await f.command('status A')).toContain('等待消息到达');
    await f.kernel.scriptMailbox('topic', state.workflowId, state.script!.runId, { kind: 'send', member: 'A', key: 'review', text: 'private-mail-text' });
    const ready = await f.command('status A');
    expect(ready).toContain('消息已到，待开始下一轮');
    expect(ready).toContain('未确认消费的消息：1');
    expect(ready).not.toContain('private-mail-text');
    await agent('revision'); await completeTurn();
    const done = await f.command('status A');
    expect(done).toContain('成员 A：本轮已完成');
    expect(done).toContain('未确认消费的消息：0');
    expect(done).toContain('恢复点：#2');
    expect(done).not.toContain('收件批次：');
    expect(await f.command('status missing')).toContain('未找到成员');
  });

  it('reports actionable failures with credential redaction and bounded output', async () => {
    const f = fixture(async request => {
      request.onSession('native-thread');
      return { status: 'failed', error: 'upstream refused Authorization: Bearer secret-token\n' + 'detail '.repeat(1000) };
    });
    await f.start();
    const state = f.kernel.state('topic')!;
    f.kernel.beginScript('topic', state.workflowId);
    await f.kernel.scriptAgent('topic', state.workflowId, state.script!.runId, { key: 'design', member: 'A', prompt: 'design' });
    await f.kernel.tick();
    await vi.waitFor(() => expect(f.kernel.state('topic')!.tasks[0]!.status).toBe('failed'));
    f.kernel.finishScript('topic', state.workflowId, state.script!.runId, { error: 'Worker failed: upstream refused' });
    const status = await f.command('status A');
    expect(status).toContain('成员 A：失败');
    expect(status).toContain('upstream refused');
    expect(status).not.toContain('secret-token');
    expect(status).toContain('排查失败原因后，可用 /workflow resume');
    expect(status!.length).toBeLessThan(2500);
    const stored = f.kernel.state('topic')!;
    const many = { ...stored, goal: 'g'.repeat(12000), tasks: Array.from({ length: 100 }, (_, i) => ({
      ...stored.tasks[0]!, agentId: undefined, taskId: String(i), scriptKey: 'long-task-'.repeat(30),
    })) };
    const task = { ...stored.tasks[0]!, agentId: undefined, taskId: 'timed', scriptKey: 'timed' };
    const timed = { ...stored, tasks: [
      { ...task, status: 'starting' as const, attempts: [{ attemptId: 'q', startedAt: 0 }] },
      { ...task, taskId: 'done', scriptKey: 'done', status: 'result_ready' as const,
        attempts: [{ attemptId: 'd', startedAt: 0, admittedAt: 120_000, endedAt: 720_000 }] },
    ], events: [{ id: 'e', kind: 'script_failed' as const, summary: 'x', acknowledged: false, notified: true, createdAt: 0 }] };
    const timing = renderWorkflowStatus(timed, undefined, false, 180_000);
    expect(timing).toContain('timed：等待执行槽位');
    expect(timing).toContain('已等待执行槽位 3 分钟');
    expect(timing).toContain('等待执行槽位 2 分钟，执行 10 分钟');
    expect(timing).toContain('执行槽位：1 个任务等待中，累计等待 5 分钟，单次最长 2 分钟');
    expect(timing).toContain('待处理事件：1，最早一条已等待 3 分钟');
    const summary = renderWorkflowStatus(many);
    expect(summary.length).toBeLessThan(8000);
    expect(summary).toContain('未展开');
  });

  it('summarizes progress for a card that hosts can update in place', async () => {
    const f = fixture();
    await f.start();
    const stored = f.kernel.state('topic')!;
    const task = { taskKey: 'k', sessionRef: 's', objective: 'o', inputRefs: [], resultRefs: [], requestDigest: 'd', attempts: [] };
    const running = { ...stored, createdAt: 0, deadlineAt: 7_200_000, script: { ...stored.script!, status: 'running' as const, phase: '评审 <b>', logs: ['a', 'b', 'c', 'd'] },
      tasks: [
        { ...task, taskId: '1', scriptKey: 'design', status: 'running' as const, attempts: [{ attemptId: 'a', startedAt: 0, admittedAt: 60_000 }] },
        { ...task, taskId: '2', scriptKey: 'queued-slot', status: 'starting' as const, attempts: [{ attemptId: 'b', startedAt: 0 }] },
        { ...task, taskId: '3', scriptKey: 'done', status: 'result_ready' as const },
        { ...task, taskId: '4', scriptKey: 'broken', status: 'failed' as const, error: 'boom' },
      ] };
    const progress = renderWorkflowProgress(running, 600_000);
    expect(progress).toMatchObject({ status: '运行中', tone: 'running', settled: false });
    expect(progress.markdown).toContain('**阶段**：评审 &lt;b&gt;');
    expect(progress.markdown).toContain('共 4，完成 1，执行中 1，等待执行槽位 1，排队 0，失败 1');
    expect(progress.markdown).toContain('- design：执行中，等待执行槽位 1 分钟，已执行 9 分钟');
    expect(progress.markdown).toContain('- queued-slot：等待执行槽位 10 分钟');
    expect(progress.markdown).toContain('- broken：boom');
    expect(progress.markdown).toContain('已用时**：10 分钟，距截止 1.8 小时');
    expect(progress.markdown).not.toContain('- a\n');
    expect(progress.markdown).toContain('- d');
    // Stopped workflows render no clock, so periodic refreshes leave the card unchanged.
    const paused = { ...running, status: 'paused' as const };
    expect(renderWorkflowProgress(paused, 600_000).markdown).toBe(renderWorkflowProgress(paused, 900_000).markdown);
    expect(renderWorkflowProgress({ ...running, script: { ...running.script, status: 'failed' as const, error: 'script threw' } }, 600_000))
      .toMatchObject({ status: '脚本失败', tone: 'failed' });
    expect(renderWorkflowProgress({ ...running, status: 'completed' as const }, 600_000)).toMatchObject({ status: '已完成', tone: 'done', settled: true });
    expect(renderWorkflowProgress({ ...running, status: 'cancelled' as const }, 600_000)).toMatchObject({ tone: 'cancelled', settled: true });
  });
  it('posts to the board as the main conversation and shows the feed', async () => {
    const f = fixture(); await f.start();
    const state = f.kernel.state('topic')!;
    f.kernel.beginScript('topic', state.workflowId);
    expect(await f.command('board')).toBe('这个工作流的留言板还没有帖子。');
    expect(await f.command('post')).toContain('用法');
    await f.kernel.scriptAgent('topic', state.workflowId, state.script!.runId, { key: 'qa-init', member: 'qa', prompt: 'verify' });
    expect(await f.command('post 先看 <README>')).toBe('已发帖 #1，未点名任何成员，不会唤醒成员。暂停或中断的工作流恢复后成员才会处理。');
    expect(await f.command('post @qa 请复核解析器')).toContain('已发帖 #2，点名：@qa');
    const feed = await f.command('board');
    expect(feed).toContain('留言板：共 2 帖，显示最近 2 帖。');
    expect(feed).toContain('#1 主会话 → 未点名');
    expect(feed).toMatch(/#2 主会话 → @qa · .* UTC\n {2}@qa 请复核解析器/);
    expect(await f.command('board 1')).not.toContain('#1 ');
    expect(await f.command('board qa')).toContain('与 qa 相关 1 帖');
    expect(await f.command('board ghost')).toContain('未找到成员：ghost');
    expect(renderWorkflowProgress(f.kernel.state('topic')!).markdown).toContain('**留言板**：2 帖，最新 #2 主会话：@qa 请复核解析器');
    expect(f.kernel.state('topic')!.mailbox!.messages).toMatchObject([{ post: 2, topic: 'board' }]);
    const current = f.kernel.state('topic')!;
    await f.kernel.call({ kind: 'main', scopeId: 'topic' }, 'post_board', { operationId: 'ruling', workflowId: current.workflowId, text: '裁定：先过对拍', topic: 'announce' });
    expect(await f.command('board')).toContain('主题：#general 2，#announce 1');
    const rulings = await f.command('board #Announce');
    expect(rulings).toContain('主题 #announce 1 帖，显示最近 1 帖。');
    expect(rulings).toMatch(/#3 \[announce\] 主会话 → 未点名/);
    expect(rulings).not.toContain('#2 ');
    expect(await f.command('board #nothing')).toBe('没有主题：#nothing。已有主题：#general #announce');
  });
});
