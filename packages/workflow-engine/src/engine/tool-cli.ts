import { readFile } from 'node:fs/promises';
import { callWorkflow } from './ipc';
import { WORKFLOW_TOOL_INSTRUCTIONS } from './tools/instructions';

export interface WorkflowToolOptions { input?: string; inputFile?: string; json?: boolean }

/** `workflow <operation>` as invoked by main agents and workers through $AGENT_WORKFLOW_CLI. */
export async function runWorkflowTool(method: string, options: WorkflowToolOptions): Promise<void> {
  // The full main-agent guide, for turns that were given only the short form.
  if (method === 'guide') { console.log(WORKFLOW_TOOL_INSTRUCTIONS); return; }
  if (options.input !== undefined && options.inputFile !== undefined) throw new Error('Choose --input or --input-file');
  const input = options.inputFile ? await readFile(options.inputFile, 'utf8') : options.input ?? '{}';
  if (input.length > 500_000) throw new Error('Workflow input exceeds size limit');
  console.log(JSON.stringify(await callWorkflow(method.replaceAll('-', '_'), JSON.parse(input)), null, 2));
}
