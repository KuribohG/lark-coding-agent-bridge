import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Folder, Square } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@shared/cn';
import { Tooltip } from '@shared/ui/tooltip';
import { commandHints, matchCommands } from '@/lib/commands';
import { baseName, modKey } from '@/lib/format';
import { useSettings } from '@/lib/settings';
import { useSession, useSessionApi } from '@/lib/use-session';
import { EnginePicker } from './EnginePicker';

export interface ComposerHandle {
  fill(text: string): void;
  focus(): void;
}

/** What was typed and not sent, per conversation. It outlives a reload of the tab, not the tab. */
const DRAFTS_KEY = 'bridge:drafts';
const drafts = savedDrafts();

function savedDrafts(): Map<string, string> {
  try { return new Map(Object.entries(JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? '{}') as Record<string, string>)); }
  catch { return new Map(); }
}

function keepDraft(key: string, text: string): void {
  if (text) drafts.set(key, text); else drafts.delete(key);
  try { sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(drafts))); }
  catch { /* no storage: the draft lasts as long as the page */ }
}
const MAX_HEIGHT = 320;

export const Composer = forwardRef<ComposerHandle, { centered?: boolean }>(function Composer({ centered }, ref) {
  const session = useSessionApi();
  const settings = useSettings();
  const meta = useSession(state => state.meta);
  const engine = useSession(state => state.engine);
  const link = useSession(state => state.link);
  const conversationId = useSession(state => state.conversationId);
  const running = useSession(() => session.runningId() !== undefined);
  const draftKey = conversationId ?? 'new';
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [sending, setSending] = useState(false);
  const [menuAt, setMenuAt] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  const hints = useMemo(() => commandHints(meta), [meta]);
  const matches = useMemo(() => menuClosed ? [] : matchCommands(hints, text), [hints, text, menuClosed]);
  const highlighted = Math.min(menuAt, Math.max(0, matches.length - 1));

  const shownKey = useRef(draftKey);
  useEffect(() => {
    const from = shownKey.current;
    shownKey.current = draftKey;
    // The empty page became a conversation under the person's hands (they chose a model for it, say): what they
    // were typing stays, and so does the focus.
    if (from === 'new' && conversationId && session.beganHere(conversationId)) { keepDraft('new', ''); return; }
    setText(drafts.get(draftKey) ?? '');
    field.current?.focus();
  }, [draftKey, conversationId, session]);
  useEffect(() => { keepDraft(draftKey, text); }, [text, draftKey]);
  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
    node.style.overflowY = node.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  useImperativeHandle(ref, () => ({
    fill: value => { setText(value); setMenuClosed(false); requestAnimationFrame(() => { field.current?.focus(); field.current?.setSelectionRange(value.length, value.length); }); },
    focus: () => field.current?.focus(),
  }), []);

  const change = (value: string) => { setText(value); setMenuAt(0); setMenuClosed(false); };

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setText('');
    keepDraft(draftKey, '');
    try { await session.send(value); }
    catch (error) {
      // The message stays on screen marked as not sent; the text goes back into the box only when it left no trace.
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { setSending(false); field.current?.focus(); }
  };

  const stop = async () => {
    try { await session.stop(); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  };

  const complete = (index: number) => {
    const hint = matches[index];
    if (!hint) return;
    change(hint.insert);
    field.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that confirms an input method's candidate is not a send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (matches.length > 0) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setMenuAt((highlighted + 1) % matches.length); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setMenuAt((highlighted - 1 + matches.length) % matches.length); return; }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); complete(highlighted); return; }
      if (event.key === 'Escape') { event.preventDefault(); setMenuClosed(true); return; }
    }
    if (event.key !== 'Enter') return;
    const mod = event.ctrlKey || event.metaKey;
    if (settings.sendKey === 'enter' ? !event.shiftKey || mod : mod) { event.preventDefault(); void send(); }
  };

  const offline = link === 'offline' || link === 'unauthorized';
  const cwd = engine?.cwd ?? meta?.workspace ?? '';

  return (
    <div className={cn('mx-auto w-full max-w-[800px] px-5 sm:px-8', centered ? '' : 'pb-4')}>
      <div className="relative">
        {matches.length > 0 && (
          <div role="listbox" aria-label="命令" className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1 shadow-pop animate-pop">
            {matches.map((hint, index) => (
              <button key={hint.insert} type="button" role="option" aria-selected={index === highlighted}
                onMouseEnter={() => setMenuAt(index)} onMouseDown={event => { event.preventDefault(); complete(index); }}
                className={cn('flex w-full items-baseline gap-3 rounded-lg px-3 py-2 text-left', index === highlighted && 'bg-hover')}>
                <span className="mono shrink-0 text-[13px] font-medium">{hint.insert.trimEnd()}</span>
                {hint.argument && <span className="mono shrink-0 text-[12px] text-subtle">{hint.argument}</span>}
                <span className="min-w-0 flex-1 truncate text-right text-[12.5px] text-muted-foreground">{hint.description}</span>
              </button>
            ))}
          </div>
        )}
        <div className={cn('rounded-2xl border border-border-strong bg-card shadow-soft transition-[border-color,box-shadow] focus-within:border-primary/45 focus-within:shadow-[0_0_0_3px_oklch(from_var(--primary)_l_c_h/11%),var(--shadow-soft)]',
          offline && 'opacity-70')}>
          <textarea ref={field} value={text} rows={1} aria-label="消息" disabled={link === 'unauthorized'}
            placeholder={running ? '补充说明，agent 会在运行中收到…' : '描述你想完成的事，或输入 / 使用命令'}
            onChange={event => change(event.target.value)} onKeyDown={onKeyDown}
            className="block max-h-80 w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-[1.6] outline-none placeholder:text-subtle" />
          <div className="flex items-center gap-1 px-2 pb-2 pt-1">
            <EnginePicker />
            {cwd && (
              <Tooltip label={cwd} side="top">
                <span className="flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted-foreground">
                  <Folder className="size-3.5 shrink-0" />
                  <span className="max-w-44 truncate">{baseName(cwd)}</span>
                </span>
              </Tooltip>
            )}
            <span className="flex-1" />
            <span className="mr-1.5 hidden text-[11.5px] text-subtle sm:inline">
              {settings.sendKey === 'enter' ? 'Enter 发送 · Shift+Enter 换行' : `${modKey}+Enter 发送`}
            </span>
            {running && (
              <Tooltip label="停止这次运行" side="top">
                <button type="button" onClick={() => void stop()} aria-label="停止"
                  className="flex h-8 items-center gap-1.5 rounded-full border border-border-strong px-3 text-[12.5px] font-medium hover:bg-hover">
                  <Square className="size-3 fill-current" />停止
                </button>
              </Tooltip>
            )}
            <Tooltip label={running ? '补充给正在运行的 agent' : '发送'} side="top">
              <button type="button" onClick={() => void send()} disabled={!text.trim() || sending || link === 'unauthorized'} aria-label={running ? '补充' : '发送'}
                className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,opacity,transform] hover:bg-primary-hover active:scale-95 disabled:bg-muted disabled:text-subtle">
                <ArrowUp className="size-4" strokeWidth={2.4} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      {!centered && <p className="mt-2 text-center text-[11.5px] text-subtle">agent 在这台机器上运行，可以读写工作目录里的文件。关掉页面不会中断任务。</p>}
    </div>
  );
});
