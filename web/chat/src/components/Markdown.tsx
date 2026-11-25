import { memo, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import { cn } from '@shared/cn';

/** Copies text where the clipboard API exists, and through a hidden field where it does not (plain HTTP). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  const field = document.createElement('textarea');
  field.value = text;
  field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(field);
  field.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* not allowed */ }
  field.remove();
  return copied;
}

export function CopyButton({ text, className, label = '复制' }: { text: string | (() => string); className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" aria-label={label} title={label}
      className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground', className)}
      onClick={async () => {
        if (await copyText(typeof text === 'function' ? text() : text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }
      }}>
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      <span>{copied ? '已复制' : label}</span>
    </button>
  );
}

function plain(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plain).join('');
  if (node && typeof node === 'object' && 'props' in node) return plain((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

function CodeBlock({ children }: ComponentProps<'pre'>) {
  const code = (Array.isArray(children) ? children[0] : children) as { props?: { className?: string; children?: ReactNode } } | undefined;
  const language = /language-([\w+#.-]+)/.exec(code?.props?.className ?? '')?.[1];
  return (
    <div className="group/code my-3 overflow-hidden rounded-lg border border-code-border bg-code text-code-foreground">
      <div className="flex h-8 items-center justify-between border-b border-code-border pl-3.5 pr-1.5">
        <span className="mono text-[11.5px] text-subtle">{language ?? 'text'}</span>
        <CopyButton text={() => plain(code?.props?.children).replace(/\n$/, '')} className="opacity-0 focus-visible:opacity-100 group-hover/code:opacity-100" />
      </div>
      <pre className="mono overflow-x-auto px-3.5 py-3 text-[12.8px] leading-[1.6]">{children}</pre>
    </div>
  );
}

const components: ComponentProps<typeof ReactMarkdown>['components'] = {
  pre: CodeBlock,
  table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
  // What an agent links to opens beside the conversation, never in place of it.
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
};

/**
 * Text written as a chat message keeps its line breaks: one newline becomes a hard break, except inside fenced
 * code. An agent's answer is not treated so; there a newline inside a paragraph is only how the source was wrapped.
 */
function keepBreaks(text: string): string {
  return text.split(/(```[\s\S]*?(?:```|$))/).map((part, index) => index % 2 ? part : part.replace(/([^\n])\n(?=[^\n])/g, '$1  \n')).join('');
}

const remarkPlugins = [remarkGfm];
const rehypePlugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];

/**
 * Markdown as the conversation shows it. Raw HTML in the text is shown as text, never as markup, and links keep
 * only safe schemes: the text comes from an agent and from the files and pages it read.
 */
export const Markdown = memo(function Markdown({ text, streaming, compact, breaks, className }: {
  text: string; streaming?: boolean; compact?: boolean; breaks?: boolean; className?: string;
}) {
  return (
    <div className={cn('prose-chat', compact && 'prose-compact', streaming && 'streaming-caret', className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>{breaks ? keepBreaks(text) : text}</ReactMarkdown>
    </div>
  );
});
