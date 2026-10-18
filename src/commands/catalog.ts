/** Data-only command metadata is shared by intake, dispatch and help rendering. */
export const commandDefinitions = [
  { name: 'new', aliases: ['reset'], access: 'user', pending: 'cancel', arguments: 'words', help: [
    '`/new` `/reset` — 清空当前 chat 的会话', '`/new chat [name]` — 新建群+新会话，自动拉你进群',
  ] },
  { name: 'btw', access: 'user', pending: 'preserve', arguments: 'verbatim', help: ['`/btw 问题` — 当前话题/聊天的旁问，记住此前旁问，不打断主任务'] },
  { name: 'resume', access: 'user', pending: 'cancel', arguments: 'words', help: ['`/resume [N]` — 列出并恢复历史会话（最多 N 条）'] },
  { name: 'cd', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/cd <path>` — 切换工作目录（会重置 session）'] },
  { name: 'ws', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/ws list|save <name>|use <name>|remove <name>` — 工作目录'] },
  { name: 'account', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/account` — 查看当前应用；`/account change` 换 appId/secret 并重连'] },
  { name: 'config', access: 'admin', pending: 'preserve', arguments: 'words', help: ['`/config` — 调整此 bot 的默认模型、思考强度、展示偏好和 lark-cli 身份策略'] },
  { name: 'model', access: 'user', pending: 'preserve', arguments: 'words', help: ['`/model [模型名|default]` — 当前话题/聊天的模型，支持手填'] },
  { name: 'effort', access: 'user', pending: 'preserve', arguments: 'words', help: ['`/effort [强度|default]` — 当前话题/聊天的思考强度；可加 `--scope profile` 改 bot 默认'] },
  { name: 'run', access: 'user', pending: 'preserve', arguments: 'verbatim', help: ['`/run` — 限时任务表单；`/run 任务` 用默认值，`/run defaults` 设置默认值，`/run status` 查看，`/run stop` 取消'] },
  { name: 'status', access: 'user', pending: 'preserve', arguments: 'words', help: ['`/status` — 当前状态'] },
  // /stop owns cancellation so it can report how many pending messages it removed.
  { name: 'stop', access: 'user', pending: 'preserve', arguments: 'words', help: [
    '`/stop` — 停止当前任务并取消排队消息（也可点卡片底部 ⏹ 终止 按钮）', '`/stop comment:<scopeHash>` — 管理员停止云文档评论任务',
  ] },
  { name: 'timeout', access: 'user', pending: 'cancel', arguments: 'words', help: [
    '`/timeout [N|off|default]` — 当前 session 的探活分钟数,`/config` 改全局默认', '`/timeout comment:<scopeHash> N` — 管理员设置云文档评论任务探活',
  ] },
  { name: 'ps', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/ps` — 列出本机所有 bot,标识当前正在回复的那个'] },
  { name: 'exit', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/exit <id|#>` — 关掉指定 bot(用 `/ps` 看 id/序号)'] },
  { name: 'reconnect', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/reconnect` — 强制重连 WebSocket(网络抖动后 bot 没反应时用)'] },
  { name: 'doctor', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/doctor [描述]` — 把日志和描述交给 {agent} 自助诊断'] },
  { name: 'inbox', access: 'user', pending: 'preserve', arguments: 'words', help: ['`/inbox` — 查看和处理会话助理事项'] },
  { name: 'invite', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/invite` — 管理用户、群聊和管理员访问权限'] },
  { name: 'remove', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/remove` — 移除用户、群聊或管理员访问权限'] },
  { name: 'meeting', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/meeting` — 加入、离开或查看会议，以及向会议智能体提问'] },
  { name: 'doc', access: 'user', pending: 'cancel', arguments: 'words', help: ['`/doc` — 云文档使用说明'] },
  { name: 'help', access: 'user', pending: 'cancel', arguments: 'words', help: ['`/help` — 本帮助'] },
] as const satisfies readonly {
  name: string;
  aliases?: readonly string[];
  access: 'user' | 'admin';
  pending: 'preserve' | 'cancel';
  arguments: 'words' | 'verbatim';
  help: readonly string[];
}[];

export type CommandName = typeof commandDefinitions[number]['name'];
export type CommandDefinition = typeof commandDefinitions[number];

const byName = new Map<string, CommandDefinition>();
for (const definition of commandDefinitions) {
  const aliases = 'aliases' in definition ? definition.aliases : [];
  for (const name of [definition.name, ...aliases]) {
    if (byName.has(name)) throw new Error(`duplicate command: ${name}`);
    byName.set(name, definition);
  }
}

export function findCommand(name: string): CommandDefinition | undefined {
  return byName.get(name.startsWith('/') ? name.slice(1) : name);
}

export function commandHelpLines(escapedAgentName: string): string[] {
  return commandDefinitions.flatMap(definition => definition.help.map(line => `- ${line.replace('{agent}', () => escapedAgentName)}`));
}
