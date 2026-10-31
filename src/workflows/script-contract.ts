import { workerSelection } from './execution';
import { DEFAULT_WORKFLOW_TIMEOUT_MINUTES } from '../config/schema';
import type { WorkerExecutionSelection, WorkflowDefinition, WorkflowRoot } from './types';

export const SCRIPT_MAX_TASKS = 128;
export const SCRIPT_MAX_TEXT = 100_000;
export const SCRIPT_MAX_REVISIONS = 8;

export const SCRIPT_DEFINITION: WorkflowDefinition = {
  apiVersion: 'bridge.workflow/v1', id: 'scripted', version: '0.7.0', kind: 'script-led',
  mainInstructions: '这是脚本驱动的跨 harness 工作流。脚本决定任务依赖，bridge 管理 worker。收到脚本完成事件后 read_artifact 并审查最终结果，再 ack_events 和 complete。失败或暂停后可 replay_script；已完成且输入、执行绑定相同的任务会复用。每个 worker 可独立选择 harness、model 和 reasoningEffort。',
  roles: { worker: { instructions: '完成脚本分配的这一项任务，遵守原始需求的授权范围。最终答复作为脚本返回值，不要只回复完成。', outputKind: 'agent-result' } },
  maxConcurrentWorkers: 4, maxRevisionRounds: SCRIPT_MAX_REVISIONS,
  maxWallTimeMinutes: DEFAULT_WORKFLOW_TIMEOUT_MINUTES, defaultWallTimeMinutes: DEFAULT_WORKFLOW_TIMEOUT_MINUTES,
};

export interface ScriptAgentCall {
  key: string;
  member?: string;
  prompt: string;
  selection: WorkerExecutionSelection;
  output: 'text' | 'json';
  workflowTool?: boolean;
}

export function scriptText(value: unknown, name: string, max = SCRIPT_MAX_TEXT): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty text of at most ${max} characters`);
  return value;
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Expected an integer between ${min} and ${max}`);
  }
  return value;
}

export function scriptArgs(value: unknown): unknown {
  const encoded = JSON.stringify(value ?? null);
  if (encoded.length > SCRIPT_MAX_TEXT) throw new Error('Script args exceed size limit');
  return JSON.parse(encoded);
}

export function parseScriptAgentCall(value: unknown, defaults: WorkerExecutionSelection, root: WorkflowRoot): ScriptAgentCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid agent() call');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['key', 'member', 'prompt', 'harness', 'model', 'reasoningEffort', 'output', 'workflowTool'].includes(key))) {
    throw new Error('agent() supports key, member, harness, model, reasoningEffort, output and workflowTool only');
  }
  if (input.workflowTool !== undefined && typeof input.workflowTool !== 'boolean') throw new Error('workflowTool must be boolean');
  const key = scriptText(input.key, 'agent key', 160);
  if (key.startsWith('@consumer/')) throw new Error('Agent key uses a reserved consumer prefix');
  if (key.trim() !== key) throw new Error('agent key must not contain surrounding whitespace');
  const output = input.output ?? 'text';
  if (output !== 'text' && output !== 'json') throw new Error('agent output must be text or json');
  const harness = input.harness ?? defaults.agentKind;
  const inherited = harness === defaults.agentKind ? defaults : { agentKind: harness };
  const selection = workerSelection({ ...inherited, agentKind: harness,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
  }, root);
  const prompt = scriptText(input.prompt, 'agent prompt');
  const member = input.member === undefined ? undefined : scriptText(input.member, 'member name', 100);
  if (member && member.trim() !== member) throw new Error('member name must not contain surrounding whitespace');
  return { key, member, output, selection, ...(input.workflowTool ? { workflowTool: true } : {}), prompt: output === 'json' ? `${prompt}\n\nReturn only valid JSON, without markdown fences or explanatory text.` : prompt };
}
