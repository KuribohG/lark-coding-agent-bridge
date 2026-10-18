import type { RuleAssessmentPolicy, SourceAdapter, SourceContext } from './contracts';
import type { WorkItem } from './types';

/** Push adapter for collectors with their own durable cursors, including GitLab CI. */
export class EventSource implements SourceAdapter {
  readonly acceptsEvents = true;
  constructor(readonly id: string, private acceptsItem: (item: WorkItem) => boolean,
    readonly assessment: RuleAssessmentPolicy = { kind: 'rule', evaluate: event =>
      ({ state: 'needed', reason: event.reason, priority: event.priority }) }) {}
  attach(_context: SourceContext): void {}
  safe(item: WorkItem): boolean { return item.origin?.sourceId === this.id && this.acceptsItem(item); }
  accepts(item: WorkItem): boolean { return this.safe(item); }
  reconcile(): void {}
  invalidate(): void {}
}
