export interface WorkItemTarget {
  transport: string;
  containerId: string;
  threadId?: string;
  replyTo?: string;
}

export interface WorkItemSourceRef {
  transport: string;
  containerId: string;
  name: string;
  kind: 'direct' | 'group' | 'external' | string;
  threadId?: string;
}

export function sameTarget(left: WorkItemTarget, right: WorkItemTarget): boolean {
  return left.transport === right.transport &&
    left.containerId === right.containerId &&
    (left.threadId ?? '') === (right.threadId ?? '') &&
    (left.replyTo ?? '') === (right.replyTo ?? '');
}
