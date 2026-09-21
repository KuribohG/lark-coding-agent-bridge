/** Resolve wall-clock input once. Persist the result, never the recurring clock. */
export function parseRunDeadline(value: string, timeZone: string, now = Date.now()): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const local = (at: number): number[] => {
    const p = Object.fromEntries(formatter.formatToParts(at).map((v) => [v.type, v.value]));
    return ['year', 'month', 'day', 'hour', 'minute', 'second'].map((key) => Number(p[key]));
  };
  let deadline: number;
  const duration = /^(\d+(?:\.\d+)?)(m|h)$/.exec(value);
  const clock = /^(\d{2}):(\d{2})$/.exec(value);
  if (duration) {
    deadline = now + Number(duration[1]) * (duration[2] === 'h' ? 3_600_000 : 60_000);
  } else if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) throw new Error('时间应为 00:00～23:59。');
    const [y, m, d] = local(now);
    const candidates: number[] = [];
    // Offset sampling also handles DST folds: pick the next actual occurrence.
    for (let day = 0; day <= 1; day++) {
      const wall = Date.UTC(y!, m! - 1, d! + day, hour, minute);
      for (let offset = -36; offset <= 36; offset += 6) {
        const sample = wall + offset * 3_600_000;
        const [sy, sm, sd, sh, si, ss] = local(sample);
        const zoneOffset = Date.UTC(sy!, sm! - 1, sd!, sh!, si!, ss!) - sample;
        const candidate = wall - zoneOffset;
        const [cy, cm, cd, ch, ci] = local(candidate);
        if (Date.UTC(cy!, cm! - 1, cd!, ch!, ci!) === wall && candidate > now) candidates.push(candidate);
      }
    }
    if (!candidates.length) throw new Error('该时区没有可用的下一次时间，请填写带时区偏移的完整日期。');
    deadline = Math.min(...candidates);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new Error('截止时间支持 01:00、2h、90m 或带时区的日期，例如 2026-09-22T01:00+08:00。');
    }
    const [date] = value.split('T');
    const [year, month, day] = date!.split('-').map(Number);
    const calendar = new Date(Date.UTC(year!, month! - 1, day!));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month! - 1 || calendar.getUTCDate() !== day) {
      throw new Error('截止日期不存在。');
    }
    deadline = Date.parse(value);
  }
  if (!Number.isFinite(deadline) || deadline <= now || deadline - now > 7 * 86_400_000) {
    throw new Error('截止时间必须在未来 7 天内。');
  }
  return Math.floor(deadline);
}

export function formatRunTime(at: number, timeZone: string): string {
  return `${new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(at)} (${timeZone})`;
}

export function deadlineInstructions(stopAt: number, windDownAt: number): string {
  return `本次为一次性限时任务。开始收尾时间：${new Date(windDownAt).toISOString()}；强制终止时间：${new Date(stopAt).toISOString()}。` +
    '请定期检查系统时间，在收尾时间前保存阶段成果、剩余事项和已有修改，预留时间给最终总结。' +
    '任务提前完成就结束；余额不足就结束，不得等待额度刷新。不得安排跨截止时间的重试、定时任务、后台服务或回调续跑。' +
    '所有工具和派生任务都必须遵守同一截止时间。强制终止由外部守护执行。';
}
