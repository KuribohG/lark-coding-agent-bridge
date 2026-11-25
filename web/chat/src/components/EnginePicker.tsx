import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronsUpDown, CornerDownLeft, Cpu, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@shared/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { Tooltip } from '@shared/ui/tooltip';
import type { ConversationState, EngineInfo, ModelChoices } from '@/lib/types';
import { useSession, useSessionApi } from '@/lib/use-session';

const report = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error));

interface Row {
  /** `null` is the default: whatever the server's configuration and the engine make of it. */
  value: string | null;
  label: string;
  hint?: string;
  group: string;
}

/** The model the conversation chose, as the list names it. */
function chosenModel(engine: ConversationState | undefined, choices: ModelChoices | undefined): string | null {
  const { model, provider } = engine?.overrides ?? {};
  if (!model) return null;
  const served = provider ? `${provider}/${model}` : model;
  return choices?.models.some(option => option.value === served) || !choices?.models.some(option => option.value === model) ? served : model;
}

function modelRows(choices: ModelChoices, chosen: string | null, query: string): Row[] {
  const rows: Row[] = [{ value: null, label: '默认', hint: choices.defaults.model ?? '由引擎决定', group: '' }];
  for (const option of choices.models) {
    // The engine's own list has an entry for "no model named", which the first row already is.
    if (option.value === 'default') continue;
    const service = choices.providers.find(provider => option.value.startsWith(`${provider.id}/`));
    rows.push(service
      ? { value: option.value, label: option.value.slice(service.id.length + 1), group: `模型服务 · ${service.label}` }
      : { value: option.value, label: option.value, hint: option.label !== option.value ? option.label : undefined, group: '' });
  }
  // A model set by hand is one of the choices too.
  if (chosen !== null && !rows.some(row => row.value === chosen)) rows.splice(1, 0, { value: chosen, label: chosen, hint: '手动填写', group: '' });
  const wanted = query.trim().toLowerCase();
  if (!wanted) return rows;
  const found = rows.filter(row => row.value !== null && `${row.value} ${row.label} ${row.hint ?? ''}`.toLowerCase().includes(wanted));
  // Models are suggestions, not an allowlist: anything typed can be used as it is.
  if (!found.some(row => row.value?.toLowerCase() === wanted)) found.push({ value: query.trim(), label: query.trim(), hint: '按这个 ID 使用', group: '' });
  return found;
}

/**
 * What runs the conversation, in the composer: the engine, its model and how hard it thinks. The chip says what the
 * next run uses; the panel changes it. A choice holds for this conversation, and is what a new one begins with.
 */
export function EnginePicker() {
  const session = useSessionApi();
  const meta = useSession(state => state.meta);
  const engine = useSession(state => state.engine);
  const conversationId = useSession(state => state.conversationId);
  const running = useSession(() => session.runningId() !== undefined);
  const [open, setOpen] = useState(false);
  const [engines, setEngines] = useState<EngineInfo[]>();
  const [loaded, setLoaded] = useState<ModelChoices>();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const [saving, setSaving] = useState<string>();
  const list = useRef<HTMLDivElement>(null);

  const agent = engine?.agent ?? meta?.agent ?? '';
  const choices = loaded?.agent === agent ? loaded : undefined;

  useEffect(() => {
    if (!open) return;
    const attempt = new AbortController();
    session.api.engines(attempt.signal).then(found => setEngines(found.engines), () => { /* every engine is offered */ });
    return () => attempt.abort();
  }, [open, session]);

  useEffect(() => {
    if (!open || !agent) return;
    const attempt = new AbortController();
    session.api.models(conversationId, agent, false, attempt.signal)
      .then(setLoaded, error => { if (!attempt.signal.aborted) report(error); });
    return () => attempt.abort();
  }, [open, agent, conversationId, session]);

  useEffect(() => { if (!open) { setQuery(''); setAt(0); } }, [open]);

  const chosen = chosenModel(engine, choices);
  const rows = useMemo(() => choices ? modelRows(choices, chosen, query) : [], [choices, chosen, query]);
  const highlighted = Math.min(at, Math.max(0, rows.length - 1));
  useEffect(() => { list.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' }); }, [highlighted, rows]);

  const change = async (what: string, act: () => Promise<void>) => {
    setSaving(what);
    try { await act(); } catch (error) { report(error); } finally { setSaving(undefined); }
  };
  const pickEngine = (value: string) => { if (value !== agent) void change(`engine:${value}`, () => session.setEngine(value)); };
  const pickModel = (value: string | null) => void change(`model:${value}`, async () => {
    const served = value !== null && choices?.providers.some(provider => value.startsWith(`${provider.id}/`));
    // A model of the engine's own list is not one of the model service chosen before it.
    await session.setModel(value === null ? { model: null } : served ? { model: value } : { model: value, provider: null });
    setQuery('');
    setAt(0);
  });
  const pickEffort = (value: string | null) => void change(`effort:${value}`, () => session.setModel({ effort: value }));
  const refresh = async () => {
    setRefreshing(true);
    try { setLoaded(await session.api.models(conversationId, agent, true)); } catch (error) { report(error); } finally { setRefreshing(false); }
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setAt((highlighted + 1) % Math.max(1, rows.length)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setAt((highlighted - 1 + rows.length) % Math.max(1, rows.length)); }
    else if (event.key === 'Enter') { event.preventDefault(); const row = rows[highlighted]; if (row) pickModel(row.value); }
  };

  const offered = engines ?? meta?.agents.map(option => ({ ...option, available: true as boolean, reason: undefined as string | undefined })) ?? [];
  const agentLabel = meta?.agents.find(option => option.value === agent)?.label ?? agent;
  const efforts = choices?.models.find(option => option.value === chosen)?.reasoningEfforts ?? choices?.efforts ?? [];
  const chosenEffort = engine?.overrides?.effort ?? null;
  const summary = [agentLabel, engine?.model ?? (engine ? '默认模型' : undefined), engine?.effort].filter(Boolean).join(' · ');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip label="引擎、模型和思考强度" side="top">
        <PopoverTrigger disabled={!meta} aria-label={`引擎和模型：${summary}`}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60 data-[state=open]:bg-hover data-[state=open]:text-foreground">
          <Cpu className="size-3.5 shrink-0" />
          <span className="max-w-72 truncate">{summary}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="start" side="top" className="flex w-[min(calc(100vw-20px),440px)] flex-col p-0"
        // Never taller than the room beside the composer: the list of models gives way and scrolls.
        style={{ maxHeight: 'var(--radix-popover-content-available-height)' }} onOpenAutoFocus={event => {
        // The search field, not the first engine: choosing a model is what the panel is opened for most.
        event.preventDefault();
        list.current?.parentElement?.querySelector('input')?.focus();
      }}>
        <section className="shrink-0 px-3.5 pb-3 pt-3">
          <h3 className="mb-2 text-[11.5px] font-medium text-subtle">执行引擎</h3>
          <div role="radiogroup" aria-label="执行引擎" className="flex flex-wrap gap-1.5">
            {offered.map(option => {
              const on = option.value === agent;
              const button = (
                <button key={option.value} type="button" role="radio" aria-checked={on} disabled={(running && !on) || !option.available || saving !== undefined}
                  onClick={() => pickEngine(option.value)}
                  className={cn('flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] transition-colors',
                    on ? 'border-primary/60 bg-accent/70 font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                    'disabled:cursor-not-allowed disabled:hover:bg-transparent', !on && 'disabled:opacity-50')}>
                  {saving === `engine:${option.value}` ? <LoaderCircle className="size-3.5 animate-spin" /> : on && <Check className="size-3.5" />}
                  {option.label}
                  {!option.available && <span className="text-[11px] font-normal text-subtle">不可用</span>}
                </button>
              );
              return option.available || !option.reason ? button
                : <Tooltip key={option.value} label={option.reason.slice(0, 200)} side="top"><span>{button}</span></Tooltip>;
            })}
          </div>
          {running && <p className="mt-2 text-[12px] leading-relaxed text-subtle">任务运行中，结束后才能换引擎。</p>}
        </section>

        <section className="flex min-h-0 shrink flex-col border-t px-3.5 pb-2 pt-3">
          <div className="mb-2 flex shrink-0 items-center">
            <h3 className="flex-1 text-[11.5px] font-medium text-subtle">
              模型{engine?.provider && <span className="font-normal">　经模型服务 {engine.provider}</span>}
            </h3>
            <Tooltip label="重新读取模型列表" side="top">
              <button type="button" aria-label="重新读取模型列表" disabled={refreshing || !choices} onClick={() => void refresh()}
                className="-my-1 rounded-md p-1 text-subtle hover:bg-hover hover:text-foreground disabled:opacity-50">
                <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
              </button>
            </Tooltip>
          </div>
          <label className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-input px-2.5 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring/40">
            <Search className="size-3.5 shrink-0 text-subtle" />
            <input value={query} onChange={event => { setQuery(event.target.value); setAt(0); }} onKeyDown={onSearchKey}
              aria-label="搜索模型，或填写模型 ID" placeholder="搜索，或直接填写模型 ID" spellCheck={false} autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle" />
          </label>
          <div ref={list} role="listbox" aria-label="模型" className="-mx-1.5 mt-1.5 max-h-[264px] min-h-[68px] shrink overflow-y-auto overscroll-contain">
            {!choices && <div className="flex h-16 items-center justify-center text-subtle"><LoaderCircle className="size-4 animate-spin" /></div>}
            {rows.map((row, index) => {
              const on = row.value === chosen;
              const heading = row.group && row.group !== rows[index - 1]?.group ? row.group : undefined;
              return (
                <div key={row.value ?? ''}>
                  {heading && <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-subtle">{heading}</div>}
                  <button type="button" role="option" aria-selected={on} data-highlighted={index === highlighted} disabled={saving !== undefined}
                    onMouseEnter={() => setAt(index)} onClick={() => pickModel(row.value)}
                    className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[13px]', index === highlighted && 'bg-hover')}>
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      {saving === `model:${row.value}` ? <LoaderCircle className="size-3.5 animate-spin text-primary" /> : on && <Check className="size-3.5 text-primary" />}
                    </span>
                    <span className={cn('min-w-0 truncate', row.value !== null && 'mono text-[12.5px]', on && 'font-medium')}>{row.label}</span>
                    {row.hint && <span className={cn('min-w-0 flex-1 truncate text-right text-[12px] text-subtle', row.value === null && 'mono')}>{row.hint}</span>}
                    {index === highlighted && query.trim() && <CornerDownLeft className="size-3 shrink-0 text-subtle" />}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <section className="shrink-0 border-t px-3.5 pb-3 pt-3">
          <h3 className="mb-2 text-[11.5px] font-medium text-subtle">
            思考强度{engine?.effort && chosenEffort === null && <span className="font-normal">　默认是 {engine.effort}</span>}
          </h3>
          <div role="radiogroup" aria-label="思考强度" className="flex flex-wrap gap-1">
            {[null, ...efforts].map(level => {
              const on = level === chosenEffort;
              return (
                <button key={level ?? ''} type="button" role="radio" aria-checked={on} disabled={saving !== undefined} onClick={() => pickEffort(level)}
                  className={cn('flex h-7 items-center gap-1 rounded-md px-2.5 text-[12.5px] transition-colors',
                    on ? 'bg-accent font-medium text-accent-foreground' : 'bg-muted/70 text-muted-foreground hover:bg-hover hover:text-foreground')}>
                  {saving === `effort:${level}` && <LoaderCircle className="size-3 animate-spin" />}
                  {level ?? '默认'}
                </button>
              );
            })}
          </div>
        </section>

        <footer className="shrink-0 rounded-b-xl border-t bg-muted/40 px-3.5 py-2 text-[12px] leading-relaxed text-subtle">
          {engine?.notice && <p className="mb-0.5 text-warning">{engine.notice}</p>}
          改动从下一轮生效；新对话沿用最近一次的选择。
        </footer>
      </PopoverContent>
    </Popover>
  );
}
