import { readFile } from 'node:fs/promises';
import { callWorkflow } from '../../workflows/ipc';

export async function runWorkflow(method: string, options: { input?: string; inputFile?: string; json?: boolean }): Promise<void> {
  if (options.input !== undefined && options.inputFile !== undefined) throw new Error('Choose --input or --input-file');
  const input = options.inputFile ? await readFile(options.inputFile, 'utf8') : options.input ?? '{}';
  if (input.length > 500_000) throw new Error('Workflow input exceeds size limit');
  console.log(JSON.stringify(await callWorkflow(method.replaceAll('-', '_'), JSON.parse(input)), null, 2));
}
