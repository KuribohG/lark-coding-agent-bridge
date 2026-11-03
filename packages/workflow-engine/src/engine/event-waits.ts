import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { availableMessages, member, memberCursor, messageMatch, receiveMessages, receiptMessages } from './durable-agents';
import { boundedInteger, scriptText } from './script-contract';
import { memberPool } from './work-routing';
import { workStatus } from './work-queue';
import type { WorkflowState, WorkflowWait, WorkflowWaitSelector } from './types';

function selector(state: WorkflowState, value: unknown): WorkflowWaitSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid waitFor selector');
  const input = value as Record<string, unknown>;
  const keys: Record<string, string[]> = { message: ['kind', 'member', 'topic', 'correlationId'], work: ['kind', 'itemId'],
    task: ['kind', 'taskId'], timer: ['kind', 'afterMs'] };
  if (!keys[String(input.kind)] || Object.keys(input).some(key => !keys[String(input.kind)]!.includes(key))) throw new Error('Unsupported waitFor selector');
  switch (input.kind) {
    case 'message': {
      const name = scriptText(input.member, 'member', 100);
      member(state, name);
      if (memberPool(state, name)) throw new Error('Consumer pool members cannot wait on mailbox events');
      return { kind: 'message', member: name, ...messageMatch(input) };
    }
    case 'work': {
      const itemId = scriptText(input.itemId, 'itemId', 100);
      workStatus(state, { itemId });
      return { kind: 'work', itemId };
    }
    case 'task': {
      const taskId = scriptText(input.taskId, 'taskId', 100);
      if (!state.script!.calls.some(call => call.taskId === taskId) || !state.tasks.some(task => task.taskId === taskId && task.scriptManaged)) throw new Error('Task handle does not belong to this script run');
      return { kind: 'task', taskId };
    }
    default: return { kind: 'timer', afterMs: boundedInteger(input.afterMs, 0, 0, 7 * 24 * 60 * 60_000) };
  }
}

function releaseBindings(state: WorkflowState, wait: WorkflowWait): void {
  for (const agent of state.agents ?? []) if (agent.wait?.kind === 'event' && agent.wait.receiptId === wait.id) agent.wait = undefined;
}

export function clearEventBindings(state: WorkflowState): void {
  for (const wait of state.waits ?? []) releaseBindings(state, wait);
}

export function beginEventWait(state: WorkflowState, input: Record<string, unknown>, now: number): WorkflowWait {
  if (Object.keys(input).some(key => !['key', 'any'].includes(key))) throw new Error('waitFor supports key and any only');
  const key = scriptText(input.key, 'wait key', 160);
  if (!Array.isArray(input.any) || !input.any.length || input.any.length > 16) throw new Error('waitFor needs 1–16 selectors');
  const any = input.any.map(value => selector(state, value));
  const cursors = any.filter(value => value.kind === 'message').map(value => ({ member: value.member, previousTurnId: memberCursor(state, member(state, value.member)) }));
  const digest = workflowDigest({ any, cursors });
  let wait = state.waits?.find(wait => wait.key === key);
  if (wait && wait.digest !== digest) throw new Error('Wait key conflict; replay the same selectors and member history');
  if (wait?.status === 'ready') { wait.runId = state.script!.runId; return wait; }
  if (!wait && (state.waits?.length ?? 0) >= 128) throw new Error('Workflow wait limit reached');
  const reserved = (state.waits ?? []).filter(other => other.id !== wait?.id && other.status === 'waiting'
    && other.runId === state.script!.runId && other.any.some(arm => arm.kind === 'message')).length;
  if (cursors.length && (state.mailbox?.receipts.length ?? 0) + reserved >= 128) throw new Error('Mailbox receive limit reached');
  const members = [...new Set(cursors.map(cursor => cursor.member))].map(name => member(state, name));
  for (const agent of members) {
    if (agent.activeTurnId || agent.lastTurnId !== memberCursor(state, agent)) throw new Error('Await the member turn before waiting for a message');
    if (agent.wait && (agent.wait.kind !== 'event' || agent.wait.receiptId !== wait?.id)) throw new Error('Member already has a pending receive');
  }
  if (!wait) {
    wait = { id: randomUUID(), key, digest, runId: state.script!.runId, any, createdAt: now, status: 'waiting' };
    (state.waits ??= []).push(wait);
  }
  wait.runId = state.script!.runId;
  for (const agent of members) agent.wait = { kind: 'event', receiptId: wait.id };
  settleEventWaits(state, now);
  return wait;
}

/** Earliest ready event wins; declaration order breaks ties. Only its mailbox reserves messages. */
export function settleEventWaits(state: WorkflowState, now: number): boolean {
  if (state.status !== 'active' || state.script?.status !== 'running') return false;
  let changed = false;
  for (const wait of state.waits ?? []) {
    if (wait.status !== 'waiting' || wait.runId !== state.script.runId) continue;
    const ready: Array<{ index: number; arm: WorkflowWaitSelector; at: number; value: unknown }> = [];
    for (const [index, arm] of wait.any.entries()) {
      let value: unknown;
      let at = wait.createdAt;
      if (arm.kind === 'timer') {
        if (now < wait.createdAt + arm.afterMs) continue;
        at = wait.createdAt + arm.afterMs;
        value = { at };
      } else if (arm.kind === 'work') {
        const item = state.workQueue?.items.find(item => item.id === arm.itemId);
        if (!item || !['completed', 'failed', 'cancelled'].includes(item.status)) continue;
        at = Math.max(wait.createdAt, item.updatedAt);
        value = { itemId: item.id, key: item.key, status: item.status, generation: item.generation, result: item.result, error: item.error };
      } else if (arm.kind === 'task') {
        const task = state.tasks.find(task => task.taskId === arm.taskId);
        if (!task || !['result_ready', 'failed', 'cancelled', 'waiting_input'].includes(task.status)) continue;
        at = Math.max(wait.createdAt, task.attempts.at(-1)?.endedAt ?? now);
        value = { taskId: task.taskId, status: task.status, error: task.error };
      } else {
        const agent = member(state, arm.member);
        const messages = availableMessages(state, agent.agentId, arm);
        if (!messages.length) continue;
        at = Math.max(wait.createdAt, messages[0]!.createdAt);
      }
      ready.push({ index, arm, at, value });
    }
    const selected = ready.sort((a, b) => a.at - b.at || a.index - b.index)[0];
    if (!selected) continue;
    releaseBindings(state, wait);
    if (selected.arm.kind === 'message') {
      const receipt = receiveMessages(state, selected.arm.member, `@wait/${wait.id}/${selected.index}`, selected.arm);
      selected.value = receiptMessages(state, receipt.id);
    }
    wait.result = { index: selected.index, kind: selected.arm.kind, value: selected.value };
    wait.status = 'ready'; changed = true;
  }
  return changed;
}
