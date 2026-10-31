import type { CardActionResponse } from '@larksuite/channel';
import { log } from '../core/logger';

const RESPONSE_BUDGET_MS = 500;
const FAILURE_NOTICE = '卡片操作未能确认完成，请查看原卡片或在原话题确认。';

/** Keep REST calls and agent input delivery out of Feishu's callback deadline. */
export function respondToCardAction(
  action: () => Promise<CardActionResponse | void>,
  notifyFailure: (notice: string) => Promise<unknown>,
): Promise<CardActionResponse | void> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  log.info('cardAction', 'received');

  return new Promise((resolve) => {
    let responded = false;
    const respond = (response: CardActionResponse | void, outcome: string) => {
      if (responded) return;
      responded = true;
      clearTimeout(timer);
      log.info('cardAction', 'response-ready', { outcome, durationMs: elapsed() });
      resolve(response);
    };
    const timer = setTimeout(() => {
      // This acknowledges the click, not successful validation or execution.
      respond({ toast: { type: 'info', content: '正在处理，请稍候。' } }, 'deferred');
    }, RESPONSE_BUDGET_MS);

    // Attach both handlers before returning, so failures after the response
    // remain observable. Timing out must never cancel or replay the action.
    void Promise.resolve().then(action).then(
      (response) => {
        log.info('cardAction', 'completed', { deferred: responded, durationMs: elapsed() });
        respond(response, 'completed');
      },
      async (err: unknown) => {
        log.fail('cardAction', err, { deferred: responded, durationMs: elapsed() });
        if (!responded) {
          respond({ toast: { type: 'error', content: FAILURE_NOTICE } }, 'failed');
          return;
        }
        try { await notifyFailure(FAILURE_NOTICE); }
        catch (noticeError) { log.fail('cardAction', noticeError, { step: 'failure-notice' }); }
      },
    );
  });
}
