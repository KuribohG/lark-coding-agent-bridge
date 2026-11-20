import { BUILTIN_WORKFLOW_TOOLS } from './tools/registry';

/** The engine registry is authoritative for direct and CLI callers. */
export const MAIN_WORKFLOW_METHODS = [...BUILTIN_WORKFLOW_TOOLS.mainNames(), 'guide'];
export const WORKER_WORKFLOW_METHODS = BUILTIN_WORKFLOW_TOOLS.workerNames();
export function workflowToolDefinitions(kind: 'main' | 'worker', allowedMethods?: readonly string[]) {
  const base = kind === 'main' ? MAIN_WORKFLOW_METHODS : WORKER_WORKFLOW_METHODS;
  const methods = allowedMethods ? base.filter(method => allowedMethods.includes(method)) : base;
  return [{ type: 'function', function: { name: 'workflow_call', description: 'Operate only the workflow bound by the current trusted host turn.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', enum: [...methods] },
      args: { type: 'object' },
    }, required: ['method', 'args'] } } }];
}
