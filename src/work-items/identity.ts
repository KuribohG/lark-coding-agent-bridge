import { createHash } from 'node:crypto';
import type { WorkItem } from './types';
import type { WorkItemEvent } from './events';

export function observationDigest(event: WorkItemEvent): string {
  const encoded = JSON.stringify(event, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return createHash('sha256').update(encoded).digest('hex');
}

export function recordObservation(item: WorkItem): void {
  item.origin ??= item.external
    ? { sourceId: item.external.source, key: item.external.key, kind: item.external.source, url: item.external.url }
    : { sourceId: 'lark', key: item.id, kind: item.source.type };
  item.evidenceVersion = (item.evidenceVersion ?? 0) + 1;
  item.businessState ??= 'open';
}

export function migrateWorkItem(item: WorkItem): void {
  if (!item.origin) {
    const version = item.evidenceVersion;
    recordObservation(item);
    item.evidenceVersion = version ?? 1;
  }
  item.businessState ??= 'open';
  if (item.external) {
    item.source = { chatId: '', name: item.source.name, type: 'external' };
    item.messages = [];
  }
}

export function evidenceSignature(item: WorkItem): string {
  // Preserve existing Lark digest receipts when migrating old state.
  return createHash('sha256').update(JSON.stringify(item.external
    ? [item.origin, item.evidenceVersion, item.external.data] : item.messages)).digest('hex');
}
