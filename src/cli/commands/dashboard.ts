import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDashboard, type DashboardSource } from '@kuribohg/agent-workflows';
import { resolveAppPaths } from '../../config/app-paths';

export interface RunDashboardOptions {
  profiles?: string[];
  db?: string[];
  host?: string;
  port?: string;
  label?: string;
  stateFile?: string;
  token?: boolean;
}

/** The workflow stores of this bridge home: one per profile that has run a workflow host. */
export function profileWorkflowStores(rootDir: string, profiles?: readonly string[]): DashboardSource[] {
  const directory = join(rootDir, 'profiles');
  const names = profiles?.length ? [...profiles] : existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : [];
  return names.map(name => ({ name, path: join(directory, name, 'workflows.sqlite') }))
    // A named profile is listed even before its first workflow; a discovered one only once its store exists.
    .filter(source => Boolean(profiles?.length) || existsSync(source.path));
}

/**
 * Serves the read-only workflow dashboard for this bridge home. It reads the profiles' workflow stores beside the
 * bridge that owns them and asks that bridge for nothing, so it runs whether or not a bridge does.
 */
export async function runDashboard(options: RunDashboardOptions): Promise<void> {
  const paths = resolveAppPaths({ rootDir: process.env.LARK_CHANNEL_HOME });
  const sources = [...profileWorkflowStores(paths.rootDir, options.profiles), ...(options.db ?? []).map(value => {
    const split = /^([A-Za-z0-9_.-]{1,64})=(.+)$/.exec(value);
    if (!split) throw new Error('--db takes name=path');
    return { name: split[1]!, path: resolve(split[2]!) };
  })];
  if (!sources.length) throw new Error(`没有找到工作流存储：${join(paths.rootDir, 'profiles')} 下还没有 profile 跑过工作流。可用 --profiles 或 --db name=path 指定。`);
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number');
  const handle = await startDashboard({ sources, host: options.host, port, label: options.label,
    stateFile: resolve(options.stateFile ?? join(paths.rootDir, 'workflow-dashboard.json')), token: options.token === false ? false : undefined });
  console.log(`工作流面板：${handle.url}`);
  console.log(`数据源：${sources.map(source => source.name).join('、')}（只读）`);
  await new Promise<void>(done => {
    const stop = () => { void handle.close().finally(done); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
