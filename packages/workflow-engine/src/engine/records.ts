import type { BoardPost, DirectMessage, MailboxMessage, MailboxReceipt, WorkClaim, WorkflowData, WorkflowEvent, WorkflowScript, WorkflowWait, WorkflowWorkItem } from './types';

/**
 * The lists of a workflow's state, other than its tasks, whose old entries move to the archive. An entry is archived
 * only once nothing will change it again; from then on it is read by its ID or key (see archivedRecord).
 */
export type RecordKind = 'post' | 'message' | 'receipt' | 'mailboxOperation' | 'workItem' | 'claim' | 'workOperation' | 'wait'
  | 'controlOperation' | 'workspaceKey' | 'notice' | 'direct' | 'mailboxCall' | 'workCall' | 'controlCall' | 'workspaceCall';

/** The script's keyed-call lists and the record kind of each. Their entries belong to one run of the script. */
export const CALL_KINDS = { mailboxCalls: 'mailboxCall', workCalls: 'workCall', controlCalls: 'controlCall', workspaceCalls: 'workspaceCall' } as const;
export type CallList = keyof typeof CALL_KINDS;

export interface RecordSpec<T> {
  list(state: WorkflowData): T[] | undefined;
  replace(state: WorkflowData, kept: T[]): void;
  /** Unique within the workflow and the kind. */
  id(entry: T, state: WorkflowData): string;
  /** The script or operation key the entry is also looked up by. */
  key?(entry: T): string | undefined;
  /** A position for range reads. */
  num?(entry: T): number;
  /** Updates the totals the state keeps about entries that left it. */
  left?(state: WorkflowData, entry: T): void;
}

type Operation = { key: string; digest: string; response: unknown };
const spec = <T>(value: RecordSpec<T>) => value as RecordSpec<unknown>;
const calls = (list: CallList) => spec<string>({
  list: state => state.script?.[list],
  replace: (state, kept) => { state.script![list] = kept; },
  id: (key, state) => callRecordId(state.script!, key),
});

/** The archive ID of a keyed script call: the same key is a different record in each run. */
export function callRecordId(script: Pick<WorkflowScript, 'runId'>, key: string): string {
  return script.runId + '\n' + key;
}

export const RECORDS: Record<RecordKind, RecordSpec<unknown>> = {
  post: spec<BoardPost>({ list: state => state.board?.posts, replace: (state, kept) => { state.board!.posts = kept; }, id: post => String(post.seq), num: post => post.seq }),
  message: spec<MailboxMessage>({ list: state => state.mailbox?.messages, replace: (state, kept) => { state.mailbox!.messages = kept; }, id: message => message.id }),
  receipt: spec<MailboxReceipt>({ list: state => state.mailbox?.receipts, replace: (state, kept) => { state.mailbox!.receipts = kept; }, id: receipt => receipt.id, key: receipt => receipt.key }),
  mailboxOperation: spec<Operation>({ list: state => state.mailbox?.operations, replace: (state, kept) => { state.mailbox!.operations = kept; }, id: operation => operation.key }),
  workItem: spec<WorkflowWorkItem>({ list: state => state.workQueue?.items, replace: (state, kept) => { state.workQueue!.items = kept; }, id: item => item.id, key: item => item.key,
    left: (state, item) => {
      const totals = (state.workQueue!.archived ??= {})[item.queue ?? 'default'] ??= {};
      totals[item.status] = (totals[item.status] ?? 0) + 1;
    } }),
  claim: spec<WorkClaim>({ list: state => state.workQueue?.claims, replace: (state, kept) => { state.workQueue!.claims = kept; }, id: claim => claim.id }),
  workOperation: spec<Operation>({ list: state => state.workQueue?.operations, replace: (state, kept) => { state.workQueue!.operations = kept; }, id: operation => operation.key }),
  wait: spec<WorkflowWait>({ list: state => state.waits, replace: (state, kept) => { state.waits = kept; }, id: wait => wait.id, key: wait => wait.key }),
  controlOperation: spec<{ key: string }>({ list: state => state.controlOperations, replace: (state, kept) => { state.controlOperations = kept as WorkflowData['controlOperations']; }, id: operation => operation.key }),
  workspaceKey: spec<string>({ list: state => state.workspaceKeys, replace: (state, kept) => { state.workspaceKeys = kept; }, id: key => key }),
  notice: spec<WorkflowEvent>({ list: state => state.events, replace: (state, kept) => { state.events = kept; }, id: notice => notice.id }),
  direct: spec<DirectMessage>({ list: state => state.direct, replace: (state, kept) => { state.direct = kept; }, id: message => message.id }),
  mailboxCall: calls('mailboxCalls'), workCall: calls('workCalls'), controlCall: calls('controlCalls'), workspaceCall: calls('workspaceCalls'),
};
