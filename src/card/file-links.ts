import type { FileLinkMapping } from '../config/file-links';

export interface FileLinkRenderOptions {
  fileLinks?: readonly FileLinkMapping[];
}

// Other formats (including code, Markdown and notebooks) open in the file browser.
const DIRECT_FILE = /\.(?:html?|txt|log|png|jpe?g|gif|webp|svg|pdf|csv|json|zip|gz|tgz|tar)$/i;
const BARE_END = /[\s`<>\[\]"'，。；！？、：]/;

/** Rewrite display text only. Work on the accumulated stream, never on token deltas. */
export function rewriteFileLinks(
  text: string,
  mappings: readonly FileLinkMapping[] = [],
  streaming = false,
): string {
  if (!mappings.length || !text.includes('/')) return text;
  const rules = [...mappings].sort((a, b) => b.localRoot.length - a.localRoot.length);
  let result = '';
  let fence: { char: string; length: number } | undefined;
  let prose = '';
  const flush = () => { result += rewriteProse(prose, rules, false); prose = ''; };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^(?: {0,3}> ?)* {0,3}(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})(.*)/.exec(line);
    if (fence) {
      result += line;
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length &&
          !marker[2]!.trim()) fence = undefined;
    } else if (marker) {
      flush();
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      result += line;
    } else if (/^(?: {4}|\t)/.test(line)) {
      flush();
      result += line;
    } else {
      prose += line;
    }
  }
  return result + rewriteProse(prose, rules, streaming);
}

function fileUrl(path: string, rules: readonly FileLinkMapping[]): string | undefined {
  // Line references are display metadata, not part of the filesystem name.
  const clean = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, '');
  if (!clean.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(clean) ||
      clean.split('/').some(p => p === '.' || p === '..')) return;
  const rule = rules.find(r => clean === r.localRoot || clean.startsWith(r.localRoot + '/'));
  if (!rule) return;
  const relative = clean.slice(rule.localRoot.length).replace(/^\//, '');
  const base = DIRECT_FILE.test(relative) ? rule.fileBaseUrl : rule.browseBaseUrl;
  try {
    const encoded = relative.split('/').map(p => encodeURIComponent(p).replace(/[!'()*]/g,
      c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
    return base + encoded;
  } catch {
    return undefined; // Incomplete Unicode must not prevent a reply from being sent.
  }
}

function label(path: string): string {
  return path.replace(/[\\[\]`*_]/g, '\\$&');
}

function rewriteProse(line: string, rules: readonly FileLinkMapping[], streaming: boolean): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\\' && i + 1 < line.length) {
      out += line.slice(i, i + 2); i += 2; continue;
    }
    if (line[i] === '`') {
      const ticks = /^`+/.exec(line.slice(i))![0];
      const end = line.indexOf(ticks, i + ticks.length);
      if (end < 0) { out += line.slice(i); break; }
      const path = line.slice(i + ticks.length, end);
      const command = /(?:\s--?\w|[|;<>]|&&)/.test(path);
      const url = command ? undefined : fileUrl(path, rules);
      out += url ? `[${label(path)}](${url})` : line.slice(i, end + ticks.length);
      i = end + ticks.length; continue;
    }
    // Keep existing links atomic, including their labels and external destinations.
    if (line[i] === '[' || (line[i] === '!' && line[i + 1] === '[')) {
      const start = line[i] === '!' ? i + 1 : i;
      const close = balancedEnd(line, start, '[', ']');
      if (close < 0) { out += line.slice(i); break; }
      if (line[close + 1] === '(') {
        const end = balancedEnd(line, close + 1, '(', ')');
        if (end < 0) { out += line.slice(i); break; }
        const inside = line.slice(close + 2, end);
        const destination = /^(?:<([^>]+)>|([^\s]+))(\s+["'][\s\S]*["'])?$/.exec(inside);
        const raw = destination?.[1] ?? destination?.[2];
        let url: string | undefined;
        if (raw) {
          // Markdown destinations may already contain percent escapes.
          try { url = fileUrl(decodeURIComponent(raw.replace(/\\([\\()[\]<>])/g, '$1')), rules); }
          catch { /* An invalid escape is not a filesystem link. */ }
        }
        out += url ? line.slice(i, close + 2) + url + (destination?.[3] ?? '') + ')' : line.slice(i, end + 1);
        i = end + 1; continue;
      }
      // Reference links/definitions are preserved rather than partially rewritten.
      if (line[close + 1] === '[' || line[close + 1] === ':') {
        out += line.slice(i); break;
      }
      out += line.slice(i, close + 1); i = close + 1; continue;
    }
    if (line[i] === '<') {
      const end = line.indexOf('>', i + 1);
      if (end < 0) { out += line.slice(i); break; }
      out += line.slice(i, end + 1); i = end + 1; continue;
    }
    // Skip complete URLs, so their path components cannot be mistaken for local paths.
    const atBoundary = i === 0 || /[\s(<]/.test(line[i - 1]!);
    const remote = atBoundary && /^[a-z][a-z\d+.-]*:\/\/[^\s<>]+/i.exec(line.slice(i));
    if (remote) { out += remote[0]; i += remote[0].length; continue; }
    if (line[i] === '/' && (i === 0 || /[\s(=，：]/.test(line[i - 1]!))) {
      let end = i;
      let parens = 0;
      while (end < line.length && !BARE_END.test(line[end]!)) {
        if (line[end] === '(') parens++;
        if (line[end] === ')') { if (!parens) break; parens--; }
        end++;
      }
      if (streaming && end === line.length) { out += line.slice(i); break; }
      const path = line.slice(i, end).replace(/[.,;!?]+$/, '');
      const url = parens === 0 ? fileUrl(path, rules) : undefined;
      if (url) { out += `[${label(path)}](${url})`; i += path.length; continue; }
      out += line.slice(i, end); i = end; continue;
    }
    out += line[i++];
  }
  return out;
}

function balancedEnd(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let angle = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (open === '(' && c === '<') angle = true;
    if (angle) { if (c === '>') angle = false; continue; }
    if (c === open) depth++;
    if (c === close && --depth === 0) return i;
  }
  return -1;
}
