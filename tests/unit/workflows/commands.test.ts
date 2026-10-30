import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowKernel } from '../../../src/workflows/kernel';
import { handleWorkflowCommand } from '../../../src/workflows/commands';
import type { WorkflowRoot } from '../../../src/workflows/types';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture() {
  const root: WorkflowRoot = {scopeId:'topic',profile:'default',agentKind:'codex',cwdRealpath:'/workspace',
    policyFingerprint:'policy',catalogBinding:'root',modelSettings:{model:'main-model',reasoningEffort:'high'}};
  const kernel = new WorkflowKernel(':memory:', {resolveRoot:async()=>root,wakeMain:async()=>{},execute:async()=>({status:'failed'}),
    resolveWorker:async(current,selection)=>({agentKind:selection.agentKind,profile:current.profile,configurationFingerprint:'config',policyFingerprint:'policy',
      modelSettings:{model:selection.model,reasoningEffort:selection.reasoningEffort}})});
  cleanup.push(()=>kernel.close());
  const submit = vi.fn<(_: string) => string | undefined>(()=>undefined);
  const command = (args: string) => handleWorkflowCommand(kernel,'topic',args,submit);
  const start = async () => kernel.call({kind:'main',scopeId:'topic'},'run_script',{operationId:randomUUID(),goal:'review',plan:'Pi with service/worker-model reviews the design and returns findings.',script:'return null;'});
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
    expect(await f.command('cancel')).toContain('已请求取消'); expect(await f.command('status')).toBe('当前没有工作流。');
    expect(await f.command('plan')).toContain('Pi with service/worker-model reviews');
  });
});
