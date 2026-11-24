#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runWorkflowTool } from './engine/tool-cli';

const fail = (error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); };

if (process.argv[2] === 'dashboard') {
  // Loaded only for this command: a worker calls this CLI for every operation and needs none of it.
  import('./dashboard/cli').then(({ runDashboardCli }) => runDashboardCli(process.argv.slice(3))).catch(fail);
} else {
  // Standalone worker CLI; accepts the same `workflow <operation>` form as the bridge CLI.
  const { positionals, values } = parseArgs({ allowPositionals: true,
    options: { input: { type: 'string' }, 'input-file': { type: 'string' }, json: { type: 'boolean' } } });
  const [command, operation] = positionals;
  if (command !== 'workflow' || !operation || positionals.length !== 2) {
    console.error('Usage: workflow <operation> [--input <JSON> | --input-file <path>] [--json]\n       dashboard --db [name=]<workflows.sqlite> ... (see dashboard --help)');
    process.exit(2);
  }
  runWorkflowTool(operation, { input: values.input, inputFile: values['input-file'], json: values.json }).catch(fail);
}
