import { open, stat } from 'node:fs/promises';
import { paths } from '../../config/paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { daemonStderrPath, daemonStdoutPath, SUPERVISOR_SERVICE_ID } from '../../daemon/paths';

const TAIL_BYTES = 64 * 1024;
const FOLLOW_INTERVAL_MS = 500;

export interface LogsOptions {
  profile?: string;
  webUi?: boolean;
  follow?: boolean;
  lines?: number;
}

export function tailLines(text: string, count: number): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-Math.max(1, count)).join('\n');
}

async function readTail(path: string): Promise<{ content: string; offset: number }> {
  try {
    const info = await stat(path);
    const start = Math.max(0, info.size - TAIL_BYTES);
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(info.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return {
        content: buffer.subarray(0, bytesRead).toString('utf8'),
        offset: start + bytesRead,
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', offset: 0 };
    throw err;
  }
}

async function readFrom(path: string, offset: number): Promise<{ content: string; offset: number }> {
  try {
    const info = await stat(path);
    const start = info.size < offset ? 0 : offset;
    if (info.size === start) return { content: '', offset: start };
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(info.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return {
        content: buffer.subarray(0, bytesRead).toString('utf8'),
        offset: start + bytesRead,
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', offset };
    throw err;
  }
}

async function resolveServiceId(opts: LogsOptions): Promise<string> {
  if (opts.webUi) return SUPERVISOR_SERVICE_ID;
  if (opts.profile) return opts.profile;
  const active = await readActiveProfile(paths.rootDir);
  const root = await loadRootConfig(paths.configFile);
  const profile = active ?? root?.activeProfile;
  if (!profile) throw new Error('active profile is required; pass --profile <name>');
  return profile;
}

export async function runLogs(opts: LogsOptions = {}): Promise<void> {
  const serviceId = await resolveServiceId(opts);
  const files = [
    { label: 'stdout', path: daemonStdoutPath(serviceId) },
    { label: 'stderr', path: daemonStderrPath(serviceId) },
  ];
  const count = Number.isSafeInteger(opts.lines) && (opts.lines ?? 0) > 0 ? opts.lines! : 100;
  const offsets = new Map<string, number>();

  for (const file of files) {
    const tail = await readTail(file.path);
    const content = tailLines(tail.content, count);
    if (content) console.log(`==> ${file.label}: ${file.path} <==\n${content}`);
    offsets.set(file.path, tail.offset);
  }
  if (!opts.follow) return;

  let reading = false;
  const timer = setInterval(() => {
    if (reading) return;
    reading = true;
    void (async () => {
      for (const file of files) {
        const next = await readFrom(file.path, offsets.get(file.path) ?? 0);
        offsets.set(file.path, next.offset);
        if (next.content) process.stdout.write(next.content);
      }
    })().catch(err => {
      console.error(`读取日志失败: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
      reading = false;
    });
  }, FOLLOW_INTERVAL_MS);
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
