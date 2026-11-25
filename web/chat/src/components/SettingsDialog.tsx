import type { ReactNode } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@shared/cn';
import { Dialog } from '@shared/ui/dialog';
import { modKey } from '@/lib/format';
import { setSettings, useSettings, type Settings } from '@/lib/settings';
import { useSession } from '@/lib/use-session';

function Choice<T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<{ value: T; label: string; icon?: ReactNode }>; onChange(value: T): void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-muted p-0.5">
      {options.map(option => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}
          className={cn('flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-muted-foreground transition-colors [&_svg]:size-3.5',
            option.value === value && 'bg-card font-medium text-foreground shadow-[0_1px_2px_oklch(0.2_0.02_265/12%)]')}>
          {option.icon}{option.label}
        </button>
      ))}
    </div>
  );
}

function Field({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium">{title}</div>
        {hint && <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const settings = useSettings();
  const meta = useSession(state => state.meta);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="设置" className="w-[min(92vw,520px)]">
      <div className="mt-3 divide-y">
        <Field title="外观">
          <Choice<Settings['theme']> label="外观" value={settings.theme} onChange={theme => setSettings({ theme })} options={[
            { value: 'system', label: '跟随系统', icon: <Monitor /> },
            { value: 'light', label: '浅色', icon: <Sun /> },
            { value: 'dark', label: '深色', icon: <Moon /> },
          ]} />
        </Field>
        <Field title="发送消息" hint={settings.sendKey === 'enter' ? 'Shift + Enter 换行' : 'Enter 换行'}>
          <Choice<Settings['sendKey']> label="发送消息" value={settings.sendKey} onChange={sendKey => setSettings({ sendKey })} options={[
            { value: 'enter', label: 'Enter' },
            { value: 'mod', label: `${modKey} + Enter` },
          ]} />
        </Field>
        <Field title="工具调用" hint="每一步的命令和输出是否直接展开">
          <Choice label="工具调用" value={settings.expandTools ? 'open' : 'closed'} onChange={value => setSettings({ expandTools: value === 'open' })} options={[
            { value: 'closed', label: '点击展开' },
            { value: 'open', label: '默认展开' },
          ]} />
        </Field>
      </div>
      {meta && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg bg-muted/60 px-3.5 py-3 text-[12.5px]">
          <dt className="text-muted-foreground">工作目录</dt><dd className="mono truncate text-[12px]" title={meta.workspace}>{meta.workspace}</dd>
          <dt className="text-muted-foreground">版本</dt><dd className="mono text-[12px]">{meta.version}{meta.commit !== 'unknown' && ` · ${meta.commit.slice(0, 7)}`}</dd>
          <dt className="text-muted-foreground">显示</dt>
          <dd>{[meta.display.show_tools ? '工具调用' : null, meta.display.show_reasoning ? '思考过程' : null].filter(Boolean).join('、') || '只显示回答'}
            <span className="text-subtle">（由服务端配置 channels.web 决定）</span></dd>
        </dl>
      )}
    </Dialog>
  );
}
