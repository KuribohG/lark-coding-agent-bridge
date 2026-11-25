import { FolderSearch, GitPullRequestArrow, ListChecks, Workflow } from 'lucide-react';
import { baseName } from '@/lib/format';
import { useSession } from '@/lib/use-session';
import { Logo } from './Logo';

const STARTERS = [
  { icon: FolderSearch, title: '了解这个项目', text: '看一下这个项目的结构，告诉我它是做什么的、主要模块怎么分工。先不要改任何文件。' },
  { icon: GitPullRequestArrow, title: '检查最近的改动', text: '看一下最近的提交和未提交的改动，指出其中可能有问题的地方。' },
  { icon: ListChecks, title: '跑测试并修复', text: '运行项目的测试，如果有失败的，找出原因并修复。' },
  { icon: Workflow, title: '交给多个 agent', text: '/workflow start ', workflow: true },
];

/** The top of the first page of a conversation that has not begun. */
export function Hero() {
  const meta = useSession(state => state.meta);
  return (
    <div className="mx-auto flex w-full max-w-[800px] flex-col items-center px-5 pb-7 text-center animate-rise sm:px-8">
      <Logo className="size-11 shadow-soft" />
      <h2 className="mt-5 text-[26px] font-semibold tracking-tight">今天想完成什么？</h2>
      {meta && (
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          agent 会在 <span className="mono rounded bg-muted px-1.5 py-0.5 text-[12.5px] text-foreground" title={meta.workspace}>{baseName(meta.workspace)}</span> 里工作
        </p>
      )}
    </div>
  );
}

/** A few things to ask first; choosing one puts it in the message box, to send or change. */
export function Starters({ onPick }: { onPick(text: string): void }) {
  const meta = useSession(state => state.meta);
  const starters = STARTERS.filter(starter => !starter.workflow || meta?.workflows);
  return (
    <div className="mx-auto w-full max-w-[800px] px-5 sm:px-8">
      <div className="mt-5 grid gap-2 animate-rise sm:grid-cols-2">
        {starters.map(starter => (
          <button key={starter.title} type="button" onClick={() => onPick(starter.text)}
            className="group flex items-start gap-3 rounded-xl border bg-card px-3.5 py-3 text-left transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-soft">
            <starter.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
            <span className="min-w-0">
              <span className="block text-[13.5px] font-medium">{starter.title}</span>
              <span className="mt-0.5 line-clamp-1 block text-[12.5px] text-muted-foreground">{starter.workflow ? '把一个大任务拆给多个 agent 并行完成' : starter.text}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
