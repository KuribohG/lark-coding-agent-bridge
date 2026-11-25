import { memo, useState } from 'react';
import { Check, CircleAlert, CircleHelp, Info, RotateCcw, Workflow, X } from 'lucide-react';
import { cn } from '@shared/cn';
import { Button } from '@shared/ui/button';
import { clock } from '@/lib/format';
import { useSessionApi } from '@/lib/use-session';
import type { NoticeItem, QuestionItem, UserItem } from '@/lib/types';
import { CopyButton, Markdown } from './Markdown';

/** What the person sent: a message, more input for a going run, or a command. */
export const UserMessage = memo(function UserMessage({ item, onRetry }: { item: UserItem; onRetry(text: string): void }) {
  const session = useSessionApi();
  return (
    <div className="group/user flex flex-col items-end pt-3 animate-rise">
      {item.via === 'input' && <span className="mb-1 mr-1 text-[11.5px] text-subtle">运行中补充</span>}
      <div className={cn('max-w-[min(85%,640px)] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-[15px] leading-[1.65]',
        item.via === 'command' && 'mono rounded-xl bg-transparent px-3 py-1.5 text-[13px] ring-1 ring-border-strong',
        item.pending && 'opacity-60', item.failed && 'ring-1 ring-destructive/50')}>
        {item.text}
      </div>
      {item.failed ? (
        <div className="mt-1.5 flex items-center gap-1 text-[12.5px] text-destructive" role="alert">
          <CircleAlert className="size-3.5" />
          <span className="mr-1">没有发出：{item.failed}</span>
          <Button variant="ghost" size="sm" onClick={() => { session.dismiss(item.key); onRetry(item.text); }}><RotateCcw />重试</Button>
          <Button variant="ghost" size="sm" onClick={() => session.dismiss(item.key)}><X />移除</Button>
        </div>
      ) : (
        <div className="flex h-6 items-center gap-1 text-[12px] text-subtle opacity-0 transition-opacity focus-within:opacity-100 group-hover/user:opacity-100">
          <span title={new Date(item.at).toLocaleString('zh-CN')}>{clock(item.at)}</span>
          <CopyButton text={item.text} />
        </div>
      )}
    </div>
  );
});

/** Something the bridge said outside any run: a workflow's plan or report, a command's reply, a refusal. */
export const Notice = memo(function Notice({ item }: { item: NoticeItem }) {
  const long = item.text.length > 1400;
  const [open, setOpen] = useState(!long);
  if (item.source === 'bridge') {
    return (
      <div className="my-2 flex gap-2.5 rounded-lg bg-warning-soft px-3.5 py-2.5 text-[13.5px] animate-rise" role="status">
        <Info className="mt-[3px] size-4 shrink-0 text-warning" />
        <div className="min-w-0 whitespace-pre-wrap break-words">{item.text}</div>
      </div>
    );
  }
  const workflow = item.source === 'workflow';
  return (
    <section className="my-2.5 overflow-hidden rounded-xl border bg-card animate-rise">
      <header className="flex h-9 items-center gap-2 border-b bg-muted/50 px-3.5 text-[12.5px]">
        {workflow ? <Workflow className="size-3.5 text-primary" /> : <Info className="size-3.5 text-muted-foreground" />}
        <span className="font-medium">{workflow ? '工作流' : 'Bridge'}</span>
        <span className="text-subtle">{clock(item.at)}</span>
        <span className="flex-1" />
        <CopyButton text={item.text} className="-mr-1.5" />
      </header>
      <div className={cn('relative px-4 py-3', !open && 'max-h-56 overflow-hidden')}>
        <Markdown text={item.text} compact breaks />
        {!open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-card to-transparent" />}
      </div>
      {long && (
        <button type="button" onClick={() => setOpen(!open)}
          className="flex h-8 w-full items-center justify-center border-t text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground">
          {open ? '收起' : '展开全部'}
        </button>
      )}
    </section>
  );
});

/** A question the agent asked, as a form until it is answered and as a record afterwards. */
export const QuestionCard = memo(function QuestionCard({ item }: { item: QuestionItem }) {
  const session = useSessionApi();
  const [picked, setPicked] = useState<string[][]>(() => item.questions.map(() => []));
  const [own, setOwn] = useState<string[]>(() => item.questions.map(() => ''));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const settled = item.status !== undefined;
  const answers = item.questions.map((_question, index) => own[index]!.trim() ? [own[index]!.trim()] : picked[index]!);
  const complete = answers.every(answer => answer.length > 0);

  const toggle = (index: number, label: string, multi: boolean) => {
    setPicked(current => current.map((chosen, at) => at !== index ? chosen
      : multi ? (chosen.includes(label) ? chosen.filter(known => known !== label) : [...chosen, label]) : [label]));
    if (!multi) setOwn(current => current.map((value, at) => at === index ? '' : value));
  };
  const submit = async () => {
    setBusy(true);
    setNote('');
    try {
      const result = await session.answer(item.id, answers);
      if (!result.settled) setNote(result.message);
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return (
    <section className={cn('my-3 overflow-hidden rounded-xl border bg-card animate-rise', !settled && 'border-primary/40 shadow-soft')}>
      <header className="flex h-10 items-center gap-2 border-b px-4 text-[13px]">
        <CircleHelp className={cn('size-4', settled ? 'text-muted-foreground' : 'text-primary')} />
        <span className="font-medium">{settled ? '提问' : '需要你的回答'}</span>
        {!settled && item.mode === 'blocking' && <span className="rounded-full bg-accent px-2 py-0.5 text-[11.5px] text-accent-foreground">任务在等待</span>}
        <span className="flex-1" />
        {settled && <span className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground"><Check className="size-3.5" />{item.status}</span>}
      </header>
      <div className="space-y-5 px-4 py-4">
        {item.questions.map((question, index) => {
          const chosen = settled ? item.answers?.[index] ?? [] : picked[index]!;
          const multi = Boolean(question.multiSelect);
          return (
            <fieldset key={index} disabled={settled || busy} className="min-w-0">
              <legend className="mb-2.5 text-[14.5px] font-medium leading-snug">
                {question.header && question.header !== question.question && (
                  <span className="mr-2 rounded bg-muted px-1.5 py-0.5 align-[1px] text-[11.5px] font-medium text-muted-foreground">{question.header}</span>
                )}
                {question.question}
                {multi && !settled && <span className="ml-2 text-[12px] font-normal text-subtle">可多选</span>}
              </legend>
              <div className="grid gap-1.5" role={multi ? 'group' : 'radiogroup'}>
                {question.options.map(option => {
                  const on = chosen.includes(option.label);
                  return (
                    <button key={option.label} type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={on}
                      onClick={() => toggle(index, option.label, multi)}
                      className={cn('flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                        on ? 'border-primary/60 bg-accent/60' : 'hover:bg-hover', settled && !on && 'opacity-55')}>
                      <span className={cn('mt-[3px] flex size-4 shrink-0 items-center justify-center border-[1.5px] transition-colors',
                        multi ? 'rounded-[5px]' : 'rounded-full', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong')}>
                        {on && (multi ? <Check className="size-3" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-primary-foreground" />)}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[14px] leading-snug">{option.label}</span>
                        {option.description && <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted-foreground">{option.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
              {settled
                ? chosen.filter(answer => !question.options.some(option => option.label === answer)).map(answer => (
                    <p key={answer} className="mt-2 rounded-lg border border-primary/60 bg-accent/60 px-3 py-2 text-[14px]">{answer}</p>
                  ))
                : (
                  <input value={own[index]} onChange={event => setOwn(current => current.map((value, at) => at === index ? event.target.value : value))}
                    onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && complete) void submit(); }}
                    placeholder={question.options.length ? '或者写下你自己的回答' : '写下你的回答'}
                    className="mt-2 h-9 w-full rounded-lg border border-input bg-transparent px-3 text-[14px] outline-none placeholder:text-subtle focus:border-primary/60 focus:ring-2 focus:ring-ring/40" />
                )}
            </fieldset>
          );
        })}
      </div>
      {!settled && (
        <footer className="flex items-center gap-3 border-t bg-muted/40 px-4 py-2.5">
          <span className="min-w-0 flex-1 text-[12.5px] text-destructive" role="alert">{note}</span>
          <Button variant="primary" disabled={!complete || busy} onClick={() => void submit()}>{busy ? '提交中…' : '提交回答'}</Button>
        </footer>
      )}
    </section>
  );
});
