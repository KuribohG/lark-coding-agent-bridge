import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, LoaderCircle } from 'lucide-react';
import { cn } from '@shared/cn';
import { Button } from '@shared/ui/button';
import { useSession, useSessionApi } from '@/lib/use-session';
import { Notice, QuestionCard, UserMessage } from './Messages';
import { RunMessage } from './RunMessage';

/** Closer to the end than this counts as being at the end. */
const NEAR_END = 96;

/**
 * The conversation, oldest first. It stays at the end while the agent writes, unless the person has scrolled up
 * to read something, and it keeps their place when older messages are added in front.
 */
export function Timeline({ onRetry }: { onRetry(text: string): void }) {
  const session = useSessionApi();
  const view = useSession(state => state.view);
  const loadingOlder = useSession(state => state.loadingOlder);
  const conversationId = useSession(state => state.conversationId);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const before = useRef<{ height: number; first: number } | null>(null);

  const toEnd = useCallback((smooth = false) => {
    const node = scroller.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useEffect(() => { pinned.current = true; setAway(false); }, [conversationId]);

  // The runs that used something else than the run before them, which the conversation marks.
  const switched = useMemo(() => {
    const keys = new Set<string>();
    let before: string | undefined;
    for (const item of view.items) {
      if (item.kind !== 'run' || !item.settings) continue;
      const used = JSON.stringify([item.settings.agent, item.settings.provider, item.settings.model, item.settings.effort]);
      if (before !== undefined && used !== before) keys.add(item.key);
      before = used;
    }
    return keys;
  }, [view.items]);

  const firstOrd = view.items[0]?.ord;
  const lastKey = view.items.at(-1)?.key;
  const lastOwn = view.items.at(-1)?.kind === 'user';

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    // Older messages were added in front: stay on the message the person was reading.
    if (before.current && firstOrd !== undefined && firstOrd < before.current.first) {
      node.scrollTop += node.scrollHeight - before.current.height;
      before.current = null;
      return;
    }
    if (pinned.current) node.scrollTop = node.scrollHeight;
  }, [view.items, firstOrd]);

  // What the person just sent is always brought into view.
  useLayoutEffect(() => { if (lastOwn) { pinned.current = true; toEnd(); } }, [lastKey, lastOwn, toEnd]);

  // Images and code blocks settle after the first layout; follow them while at the end.
  useEffect(() => {
    const node = scroller.current;
    const content = node?.firstElementChild;
    if (!node || !content) return;
    const observer = new ResizeObserver(() => { if (pinned.current) node.scrollTop = node.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    const atEnd = node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_END;
    pinned.current = atEnd;
    setAway(!atEnd);
  };

  const older = () => {
    const node = scroller.current;
    if (node && firstOrd !== undefined) before.current = { height: node.scrollHeight, first: firstOrd };
    void session.loadOlder();
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-[800px] px-5 pb-10 pt-6 sm:px-8">
          {view.more && (
            <div className="flex justify-center pb-4">
              <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={older}>
                {loadingOlder && <LoaderCircle className="animate-spin" />}
                {loadingOlder ? '正在加载' : '加载更早的消息'}
              </Button>
            </div>
          )}
          {!view.ready && view.items.length === 0 && (
            <div className="space-y-5 pt-4" aria-hidden>
              {[72, 100, 56].map((width, index) => (
                <div key={index} className={cn('h-4 rounded-full bg-muted animate-pulse', index === 0 && 'ml-auto')} style={{ width: `${width * 0.6}%` }} />
              ))}
            </div>
          )}
          <div role="log" aria-live="polite" aria-relevant="additions">
            {view.items.map(item => {
              switch (item.kind) {
                case 'user': return <UserMessage key={item.key} item={item} onRetry={onRetry} />;
                case 'run': return <RunMessage key={item.key} item={item} switched={switched.has(item.key)} />;
                case 'notice': return <Notice key={item.key} item={item} />;
                case 'question': return <QuestionCard key={item.key} item={item} />;
              }
            })}
          </div>
        </div>
      </div>
      <div className={cn('pointer-events-none absolute inset-x-0 bottom-3 flex justify-center transition-opacity', away ? 'opacity-100' : 'opacity-0')}>
        <button type="button" aria-label="回到最新" tabIndex={away ? 0 : -1} onClick={() => { pinned.current = true; toEnd(true); }}
          className={cn('flex size-8 items-center justify-center rounded-full border bg-popover text-muted-foreground shadow-soft hover:text-foreground', away && 'pointer-events-auto')}>
          <ArrowDown className="size-4" />
        </button>
      </div>
    </div>
  );
}
