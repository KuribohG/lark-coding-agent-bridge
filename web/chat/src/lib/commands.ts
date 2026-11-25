import type { Meta } from './types';

export interface CommandHint {
  /** What is put in the message box; ends with a space when the command takes more words. */
  insert: string;
  /** The words still to be typed, shown after the command. */
  argument?: string;
  description: string;
}

const WORKFLOW: CommandHint[] = [
  { insert: '/workflow start ', argument: '任务描述', description: '把一个大任务交给多个 agent 分工完成' },
  { insert: '/workflow status', description: '查看工作流现在的进度' },
  { insert: '/workflow plan', description: '查看工作流的执行方案' },
  { insert: '/workflow work', description: '查看任务队列' },
  { insert: '/workflow board', description: '查看成员之间的留言' },
  { insert: '/workflow goal ', argument: '新的目标', description: '查看或修改工作流的目标' },
  { insert: '/workflow post ', argument: '留言', description: '给工作流的成员留言' },
  { insert: '/workflow pause', description: '暂停工作流' },
  { insert: '/workflow resume', description: '继续已暂停的工作流' },
  { insert: '/workflow cancel', description: '取消工作流' },
  { insert: '/workflow help', description: '工作流命令的完整用法' },
];

const DESCRIPTIONS: Record<string, string> = {
  help: '列出可用的命令',
  new: '清除这个对话里 agent 的记忆，从头开始',
  status: '查看当前引擎和运行状态',
  stop: '停止正在进行的运行',
  model: '查看这个对话使用的引擎',
};

/** The commands the message box offers when a message starts with a slash. */
export function commandHints(meta: Meta | undefined): CommandHint[] {
  if (!meta) return [];
  const own = meta.commands.map(command => ({
    insert: `/${command.name}`,
    description: DESCRIPTIONS[command.name] ?? command.help[0]?.replace(/^`[^`]*`\s*—\s*/, '') ?? '',
  }));
  return [...(meta.workflows ? WORKFLOW : []), ...own];
}

export function matchCommands(hints: CommandHint[], typed: string): CommandHint[] {
  if (!typed.startsWith('/') || typed.includes('\n')) return [];
  const query = typed.toLowerCase();
  const matches = hints.filter(hint => hint.insert.toLowerCase().startsWith(query) && hint.insert.trimEnd().toLowerCase() !== query.trimEnd());
  // `/work` narrows the workflow commands; a bare `/` shows one line for the family rather than all of it.
  if (query === '/') {
    const families = new Set<string>();
    return hints.filter(hint => {
      const family = hint.insert.split(' ')[0]!;
      if (family !== '/workflow') return true;
      if (families.has(family)) return false;
      families.add(family);
      return true;
    }).map(hint => hint.insert.startsWith('/workflow ') ? { insert: '/workflow ', argument: 'start · status · cancel …', description: '多个 agent 分工完成一个大任务' } : hint);
  }
  return matches;
}
