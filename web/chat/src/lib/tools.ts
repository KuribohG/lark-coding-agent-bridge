import type { ToolEntry } from './types';

export type ToolFamily = 'shell' | 'read' | 'write' | 'search' | 'web' | 'agent' | 'plan' | 'workflow' | 'other';

export interface ToolSummary {
  family: ToolFamily;
  /** What the call does, in a word or two. */
  verb: string;
  /** What it does it to: a command, a path, a pattern. */
  target: string;
  /** Set when the target is a shell command, shown as code. */
  code?: boolean;
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

function field(input: unknown, ...names: string[]): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  for (const name of names) {
    const found = text(record[name]);
    if (found) return found;
    if (Array.isArray(record[name])) return (record[name] as unknown[]).filter(part => typeof part === 'string').join(' ') || undefined;
  }
  return undefined;
}

const FAMILIES: Array<[RegExp, ToolFamily, string]> = [
  [/^(bash|shell|exec|exec_command|local_shell|run_command|terminal|sh|container\.exec|bashoutput|killshell|killbash)$/i, 'shell', '运行命令'],
  [/^(read|read_file|view|cat|notebookread|read_many_files|view_image)$/i, 'read', '读取'],
  [/^(edit|multiedit|write|write_file|apply_patch|str_replace|str_replace_editor|notebookedit|create|create_file|patch)$/i, 'write', '修改'],
  [/^(grep|glob|search|find|ls|list_dir|list_directory|ripgrep|search_files|codebase_search|toolsearch)$/i, 'search', '查找'],
  [/^(webfetch|websearch|web_search|fetch|browser|http|web_fetch)$/i, 'web', '访问网页'],
  [/^(task|agent|subagent|spawn_agent|dispatch_agent|sendmessage)$/i, 'agent', '子代理'],
  [/^(todowrite|todoread|update_plan|plan|exitplanmode|enterplanmode)$/i, 'plan', '更新计划'],
];

/** What a tool call amounts to for someone reading along; agents name the same tools differently. */
export function summarize(tool: ToolEntry): ToolSummary {
  const name = tool.name.replace(/^mcp__/, '').replace(/__/g, ' · ');
  const short = tool.name.split(/[.:/]|__/).pop() ?? tool.name;
  const known = FAMILIES.find(([pattern]) => pattern.test(short) || pattern.test(tool.name));
  const input = tool.input;
  if (/workflow/i.test(tool.name)) {
    return { family: 'workflow', verb: '工作流', target: field(input, 'operation', 'op', 'action', 'command') ?? name };
  }
  if (known) {
    const [, family, verb] = known;
    switch (family) {
      case 'shell': {
        const command = field(input, 'command', 'cmd', 'script', 'args') ?? (typeof input === 'string' ? input : undefined);
        return { family, verb, target: command ?? field(input, 'description') ?? name, code: Boolean(command) };
      }
      case 'read':
      case 'write': {
        const path = field(input, 'file_path', 'path', 'file', 'filename', 'notebook_path', 'target_file');
        return { family, verb: family === 'write' && /^(write|write_file|create|create_file)$/i.test(short) ? '写入' : verb, target: path ?? name };
      }
      case 'search': {
        const what = field(input, 'pattern', 'query', 'glob', 'regex', 'q');
        const where = field(input, 'path', 'dir', 'directory');
        return { family, verb, target: [what, where && `于 ${where}`].filter(Boolean).join(' ') || name };
      }
      case 'web':
        return { family, verb: /search/i.test(short) ? '搜索网页' : verb, target: field(input, 'url', 'query', 'q') ?? name };
      case 'agent':
        return { family, verb, target: field(input, 'description', 'subagent_type', 'name', 'prompt') ?? name };
      default:
        return { family, verb, target: '' };
    }
  }
  return { family: 'other', verb: name, target: field(input, 'description', 'command', 'path', 'file_path', 'query', 'url', 'name') ?? '' };
}

/** A tool's input as text a person can read: a command as it was typed, anything else as indented JSON. */
export function inputText(tool: ToolEntry): string {
  const input = tool.input;
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && typeof record[keys[0]!] === 'string') return record[keys[0]!] as string;
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}
