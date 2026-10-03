export interface FileLinkMapping {
  localRoot: string;
  fileBaseUrl: string;
  browseBaseUrl: string;
  /** Optional lightweight viewer; receives the absolute filesystem path as ?path=. */
  markdownPreviewUrl?: string;
}

/** Explicit POSIX directory mappings; URLs must not carry login credentials. */
export function normalizeFileLinks(input: unknown): FileLinkMapping[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error('fileLinks must be an array');
  const roots = new Set<string>();
  return input.map((value: unknown) => {
    const rule = value as Partial<FileLinkMapping> | null;
    const root = rule?.localRoot;
    if (typeof root !== 'string' || !root.startsWith('/') || root.startsWith('//') ||
        /[\\\x00-\x1f\x7f]/.test(root) || root.split('/').some(p => p === '.' || p === '..')) {
      throw new Error('fileLinks.localRoot must be an absolute POSIX directory without dot segments');
    }
    const localRoot = root.replace(/\/+$/, '');
    if (!localRoot || roots.has(localRoot)) throw new Error('fileLinks roots must be non-root and unique');
    roots.add(localRoot);
    return {
      localRoot,
      fileBaseUrl: baseUrl(rule?.fileBaseUrl),
      browseBaseUrl: baseUrl(rule?.browseBaseUrl),
      ...(rule?.markdownPreviewUrl === undefined ? {} : { markdownPreviewUrl: httpsUrl(rule.markdownPreviewUrl).href }),
    };
  });
}

function baseUrl(value: unknown): string {
  return httpsUrl(value).href.replace(/\/+$/, '') + '/';
}

function httpsUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('fileLinks base URLs must be HTTPS URLs');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('fileLinks base URLs must use HTTPS without credentials, query or fragment');
  }
  return url;
}
