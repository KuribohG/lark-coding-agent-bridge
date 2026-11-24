import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { DashboardSource } from './api';
import { startDashboard } from './server';

const USAGE = `Usage: dashboard --db [name=]<workflows.sqlite> [--db ...] [--host 127.0.0.1] [--port 0]
                 [--label <text>] [--state-file <path>] [--token <text> | --no-token]

Serves a read-only web dashboard of the workflows in the given stores. The stores are opened read-only and may be in
use by a running host. --state-file records the address and token (0600) for a local proxy or launcher.`;

/** `name=path`, or a path alone, which is named after the directory that holds it. */
export function dashboardSource(value: string): DashboardSource {
  const split = /^([A-Za-z0-9_.-]{1,64})=(.+)$/.exec(value);
  const path = resolve(split ? split[2]! : value);
  return { name: split ? split[1]! : basename(dirname(path)) || 'workflows', path };
}

/** `dashboard` as a command: serves until the process is told to stop. */
export async function runDashboardCli(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...argv], options: {
    db: { type: 'string', multiple: true }, host: { type: 'string' }, port: { type: 'string' }, label: { type: 'string' },
    'state-file': { type: 'string' }, token: { type: 'string' }, 'no-token': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help || !values.db?.length) {
    console.error(USAGE);
    process.exitCode = values.help ? 0 : 2;
    return;
  }
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number');
  const handle = await startDashboard({ sources: values.db.map(dashboardSource), host: values.host, port, label: values.label,
    stateFile: values['state-file'] ? resolve(values['state-file']) : undefined, token: values['no-token'] ? false : values.token });
  console.log(`Workflow dashboard: ${handle.url}`);
  await new Promise<void>(done => {
    const stop = () => { void handle.close().finally(done); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
