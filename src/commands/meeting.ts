import { describeMeetingError, type MeetingManager } from '../meeting/manager';
import { isMeetingNo } from '../meeting/api';
import { answerInMeeting, meetingScopeId } from '../meeting/orchestrator';
import type { MeetingSession } from '../meeting/session';
import type { CommandContext } from './types';
import { reply } from './presentation';

// ────────────── /meeting — in-meeting agent (智能体入会) ──────────────

/**
 * `/meeting` drives the bot's presence in a Feishu video meeting: join by
 * 9-digit number, leave, inspect what the session has captured, and ask the
 * agent a question with the meeting transcript as context.
 */
export async function handleMeeting(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ');
  const manager = ctx.controls.meeting;

  if (!ctx.controls.profileConfig.meeting.enabled) {
    await reply(
      ctx,
      '会议智能体未启用。在 `/config` 或 Web 控制台里开启「会议智能体」后重启 bot 即可。',
    );
    return;
  }
  if (!manager) {
    await reply(ctx, '会议能力未就绪（channel 未连接或启用后尚未重启）。');
    return;
  }

  switch (sub) {
    case '':
    case 'status':
      await replyMeetingStatus(ctx, manager);
      return;
    case 'join': {
      const meetingNo = rest.replace(/\s/g, '');
      if (!isMeetingNo(meetingNo)) {
        await reply(ctx, '用法：`/meeting join <9位会议号>`（只接受 9 位纯数字，不是会议链接）');
        return;
      }
      try {
        const session = await manager.join(meetingNo, { originChatId: ctx.msg.chatId });
        await reply(
          ctx,
          `✅ 已入会 **${session.topic ?? meetingNo}**\n` +
            `会议号 ${session.meetingNo} · 会中发 \`${ctx.controls.profileConfig.meeting.trigger} 你的问题\` 可以问我\n` +
            '`/meeting notes` 总结 · `/meeting leave` 离会',
        );
      } catch (err) {
        await reply(ctx, `入会失败：${describeMeetingError(err)}`);
      }
      return;
    }
    case 'leave': {
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      await manager.leave(picked.session.meetingId);
      await reply(ctx, `✅ 已离会（会议号 ${picked.session.meetingNo}）`);
      return;
    }
    case 'transcript': {
      // Shows exactly what the agent is given as context. Without this, "why
      // did it mention X?" is unanswerable — the buffer is invisible.
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const lines = picked.session.recentTranscript();
      if (lines.length === 0) {
        await reply(
          ctx,
          '字幕缓冲为空 —— agent 这次拿到的会议上下文是「（暂无字幕）」。\n' +
            '注意：同一场会里 agent 复用一个会话，**早先轮次**的字幕仍留在它自己的对话历史里，' +
            '所以它可能引用缓冲里已经没有的内容。`/new` 可以清掉该会话记忆。',
        );
        return;
      }
      const tail = lines.slice(-30);
      await reply(
        ctx,
        [
          `字幕缓冲共 ${lines.length} 条${tail.length < lines.length ? `，以下是最近 ${tail.length} 条` : ''}：`,
          '```',
          ...tail,
          '```',
        ].join('\n'),
      );
      return;
    }
    case 'stop': {
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const stopped = ctx.activeRuns.interrupt(meetingScopeId(picked.session.meetingId));
      await reply(ctx, stopped ? '✅ 已中断该会议的当前任务。' : '该会议当前没有正在执行的任务。');
      return;
    }
    case 'notes':
    case 'ask': {
      // `notes` takes an optional meeting number; `ask` takes the question, so
      // only `notes` can disambiguate positionally.
      const picked = pickMeetingSession(manager, ctx, sub === 'notes' ? rest : '');
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const session = picked.session;
      const question =
        sub === 'notes'
          ? '请基于以上会议字幕做一份简洁纪要：讨论了什么、结论、待办（如有）。'
          : rest;
      if (!question) {
        await reply(ctx, '用法：`/meeting ask <问题>`');
        return;
      }
      if (!ctx.runExecutor) {
        await reply(ctx, '当前上下文无法执行 agent（缺少 run executor）。');
        return;
      }
      await reply(ctx, sub === 'notes' ? '正在总结会议…' : '正在思考…');
      try {
        const answer = await answerInMeeting(
          {
            session,
            channel: ctx.channel,
            controls: ctx.controls,
            executor: ctx.runExecutor,
            activeRuns: ctx.activeRuns,
            sessions: ctx.sessions,
            ...(ctx.sessionCatalog ? { sessionCatalog: ctx.sessionCatalog } : {}),
            workspaces: ctx.workspaces,
          },
          question,
          // Typed privately -> answer only to the caller. Broadcasting a
          // summary somebody asked for in a DM would surprise the meeting.
          { deliver: 'caller' },
        );
        await reply(ctx, answer || '（没有产生回答）');
      } catch (err) {
        await reply(ctx, `执行失败：${describeMeetingError(err)}`);
      }
      return;
    }
    default:
      await reply(
        ctx,
        [
          '用法：',
          '`/meeting` — 状态',
          '`/meeting join <9位会议号>` — 让 bot 入会',
          '`/meeting leave [会议号]` — 离会',
          '`/meeting notes [会议号]` — 基于字幕做纪要（只发给你）',
          '`/meeting stop [会议号]` — 中断该会议卡住的任务',
          '`/meeting transcript [会议号]` — 看 agent 实际拿到的字幕上下文',
          '`/meeting ask <问题>` — 带会议上下文提问',
        ].join('\n'),
      );
  }
}

type PickedSession =
  | { ok: true; session: MeetingSession }
  | { ok: false; message: string };

/**
 * Resolve which meeting a command targets when the bot may be in several.
 *
 * Order: explicit 9-digit number → the only meeting → the only meeting joined
 * from *this* chat → otherwise ask, listing the candidates. Silently defaulting
 * to "the first one" would act on the wrong meeting.
 */
function pickMeetingSession(
  manager: MeetingManager,
  ctx: CommandContext,
  explicit: string,
): PickedSession {
  const wanted = explicit.replace(/\s/g, '');
  if (wanted) {
    const found = manager.byMeetingNo(wanted);
    return found
      ? { ok: true, session: found }
      : { ok: false, message: `没找到会议号 ${wanted} 对应的会议。用 \`/meeting\` 看当前在跟哪几场。` };
  }

  const all = manager.all();
  if (all.length === 0) {
    return { ok: false, message: '当前没有在跟的会议。先 `/meeting join <9位会议号>`。' };
  }
  if (all.length === 1) return { ok: true, session: all[0]! };

  // Multiple meetings: prefer the one started from this chat.
  const fromHere = all.filter((s) => s.originChatId === ctx.msg.chatId);
  if (fromHere.length === 1) return { ok: true, session: fromHere[0]! };

  const list = all.map((s) => `- ${s.meetingNo}${s.topic ? `（${s.topic}）` : ''}`).join('\n');
  return {
    ok: false,
    message: `当前在跟 ${all.length} 场会议，请指定会议号：\n${list}\n\n例如 \`/meeting notes ${all[0]!.meetingNo}\``,
  };
}

async function replyMeetingStatus(ctx: CommandContext, manager: MeetingManager): Promise<void> {
  const sessions = manager.list();
  const push = manager.pushHealth();
  const pushLine = push.hooked
    ? `推送：已挂载，累计收到 ${push.received} 条${push.received === 0 ? '（尚未收到，可能还没在后台订阅 vc.bot.* 事件）' : ''}`
    : `推送：未挂载（${push.reason ?? '未知原因'}），仅靠轮询`;

  if (sessions.length === 0) {
    await reply(ctx, [`当前没有在跟的会议。`, pushLine, '', '`/meeting join <9位会议号>` 开始。'].join('\n'));
    return;
  }
  const lines = sessions.map(
    (s) =>
      `- **${s.topic ?? s.meetingNo}**（${s.meetingNo}）· 来源 ${s.source === 'push' ? '推送' : '轮询'}` +
      ` · 字幕 ${s.transcriptLines} 条 · 参会 ${s.participants} 人`,
  );
  await reply(ctx, [`正在跟 ${sessions.length} 场会议：`, ...lines, '', pushLine].join('\n'));
}
