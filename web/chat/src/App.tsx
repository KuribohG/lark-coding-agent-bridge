import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, WifiOff } from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { Button } from '@shared/ui/button';
import { Dialog } from '@shared/ui/dialog';
import { TooltipProvider } from '@shared/ui/tooltip';
import { setSidebar, sidebarOpen, useSidebar } from '@/lib/settings';
import type { Conversation } from '@/lib/types';
import { useSession, useSessionApi } from '@/lib/use-session';
import { CommandPalette } from '@/components/CommandPalette';
import { Composer, type ComposerHandle } from '@/components/Composer';
import { Header } from '@/components/Header';
import { Logo } from '@/components/Logo';
import { SettingsDialog } from '@/components/SettingsDialog';
import { Sidebar } from '@/components/Sidebar';
import { Timeline } from '@/components/Timeline';
import { Hero, Starters } from '@/components/Welcome';
import { WorkflowPanel } from '@/components/WorkflowPanel';

/** Shown instead of the app when the page has no valid token: the link is the key, and a new one comes with every start. */
function Locked() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><KeyRound className="size-5" /></div>
        <h1 className="mt-5 text-[19px] font-semibold tracking-tight">这个链接打不开对话</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
          页面需要启动命令输出的完整链接才能连接到这台机器上的 agent。服务每次启动都会换一个新链接，旧的随之失效。
        </p>
        <div className="mono mt-5 rounded-xl border bg-card px-4 py-3 text-left text-[12px] leading-relaxed text-muted-foreground">
          <span className="text-subtle">$</span> lark-channel-bridge web --workspace .<br />
          Bridge: <span className="text-foreground">http://127.0.0.1:8787/#token=…</span>
        </div>
        <p className="mt-4 text-[12.5px] text-subtle">在终端里找到最近一次启动输出的链接，整条复制到地址栏打开。</p>
      </div>
    </div>
  );
}

export function App() {
  const session = useSessionApi();
  const sidebar = useSidebar();
  const link = useSession(state => state.link);
  const fatal = useSession(state => state.fatal);
  const blank = useSession(state => !state.conversationId || (state.view.ready && state.view.items.length === 0));
  const gone = useSession(state => state.view.gone);
  const [panel, setPanel] = useState(false);
  const [palette, setPalette] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [removing, setRemoving] = useState<Conversation | null>(null);
  const composer = useRef<ComposerHandle>(null);

  const fill = useCallback((text: string) => composer.current?.fill(text), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') { event.preventDefault(); setPalette(open => !open); }
      else if (key === 'b' && !event.shiftKey) { event.preventDefault(); setSidebar(!sidebarOpen()); }
      else if (key === 'o' && event.shiftKey) { event.preventDefault(); session.open(undefined); composer.current?.focus(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [session]);

  // A conversation deleted in another tab leaves nothing to show here.
  useEffect(() => { if (gone) { toast('这个对话已被删除'); session.open(undefined); } }, [gone, session]);

  if (link === 'unauthorized') return <Locked />;
  if (fatal) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Logo className="size-10 opacity-60" />
        <p className="text-[14px] font-medium">页面没能启动</p>
        <p className="max-w-sm text-[13px] text-muted-foreground">{fatal}</p>
        <Button onClick={() => location.reload()}>重新加载</Button>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={200}>
      <div className="flex h-full">
        {sidebar && (
          <>
            <div className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={() => setSidebar(false)} aria-hidden />
            <div className="max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:shadow-pop">
              <Sidebar onSettings={() => setSettingsOpen(true)} onSearch={() => setPalette(true)} onRemove={setRemoving} />
            </div>
          </>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <Header panel={panel} onPanel={() => setPanel(open => !open)} onRemove={setRemoving} />
          {link === 'offline' && (
            <div className="flex items-center justify-center gap-2 border-b bg-warning-soft px-4 py-1.5 text-[12.5px]" role="status">
              <WifiOff className="size-3.5 text-warning" />连不上服务，正在重试。运行中的任务不受影响，恢复后会接着显示。
            </div>
          )}
          {blank ? (
            <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto pb-[10vh] pt-6">
              <Hero />
              <Composer ref={composer} centered />
              <Starters onPick={fill} />
            </div>
          ) : (
            <>
              <Timeline onRetry={fill} />
              <Composer ref={composer} />
            </>
          )}
        </main>
        {panel && (
          <>
            <div className="fixed inset-0 z-20 bg-black/30 lg:hidden" onClick={() => setPanel(false)} aria-hidden />
            <div className="max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:shadow-pop">
              <WorkflowPanel onClose={() => setPanel(false)} onStart={() => fill('/workflow start ')} />
            </div>
          </>
        )}
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} onSettings={() => setSettingsOpen(true)} onPanel={() => setPanel(open => !open)} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <Dialog open={removing !== null} onOpenChange={open => { if (!open) setRemoving(null); }} title="删除这个对话？"
        description={`「${removing?.title ?? ''}」的消息记录和 agent 的会话记忆都会被删除，无法恢复。它改过的文件不受影响。`}>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setRemoving(null)}>取消</Button>
          <Button variant="danger" onClick={() => {
            const target = removing;
            setRemoving(null);
            if (target) session.remove(target.id).catch(error => toast.error(error instanceof Error ? error.message : String(error)));
          }}>删除</Button>
        </div>
      </Dialog>
      <Toaster position="top-center" toastOptions={{ className: '!rounded-xl !border !border-border !bg-popover !text-popover-foreground !shadow-pop !text-[13px]' }} />
    </TooltipProvider>
  );
}
