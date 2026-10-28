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
    : { sourceId: item.sourceRef.transport, key: item.id, kind: item.sourceRef.kind };
  item.evidenceVersion = (item.evidenceVersion ?? 0) + 1;
  item.businessState ??= 'open';
}

export function evidenceSignature(item: WorkItem): string {
  return createHash('sha256').update(JSON.stringify(item.external
    ? [item.origin, item.evidenceVersion, item.external.data] : item.messages)).digest('hex');
}
