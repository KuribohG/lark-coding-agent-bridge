import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { parkedMembers } from './board';
import { availableMessages, member, memberCursor, messageMatch, receiveMessages, receiptMessages } from './durable-agents';
import { taskById } from './kernel-state';
import { emit } from './kernel-store';
import { boundedInteger, scriptText } from './script-contract';
import { memberPool } from './work-routing';
import { workStatus } from './work-queue';
import type { Immutable, WorkflowView, WorkflowWait, WorkflowWaitSelector } from './types';

function selector(state: WorkflowView, value: unknown): WorkflowWaitSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid waitFor selector');
  const input = value as Record<string, unknown>;
  const keys: Record<string, string[]> = { message: ['kind', 'member', 'topic', 'correlationId'], work: ['kind', 'itemId'],
    task: ['kind', 'taskId'], timer: ['kind', 'afterMs'], quiet: ['kind', 'members'] };
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
      if (!state.script!.calls.some(call => call.taskId === taskId) || !taskById(state, taskId)?.scriptManaged) throw new Error('Task handle does not belong to this script run');
      return { kind: 'task', taskId };
    }
    case 'quiet': {
      if (!Array.isArray(input.members) || !input.members.length || input.members.length > 32) throw new Error('quiet needs 1–32 member names');
      const names = input.members.map(name => scriptText(name, 'member', 100));
      if (new Set(names).size !== names.length) throw new Error('quiet member names must be unique');
      for (const name of names) member(state, name);
      return { kind: 'quiet', members: names };
    }
    default: return { kind: 'timer', afterMs: boundedInteger(input.afterMs, 0, 0, 7 * 24 * 60 * 60_000) };
  }
}

export function beginEventWait(state: WorkflowView, input: Record<string, unknown>, now: number): Immutable<WorkflowWait> {
  if (Object.keys(input).some(key => !['key', 'any'].includes(key))) throw new Error('waitFor supports key and any only');
  const key = scriptText(input.key, 'wait key', 160);
  if (!Array.isArray(input.any) || !input.any.length || input.any.length > 16) throw new Error('waitFor needs 1–16 selectors');
  const any = input.any.map(value => selector(state, value));
  const cursors = any.filter(value => value.kind === 'message').map(value => ({ member: value.member, previousTurnId: memberCursor(state, member(state, value.member)) }));
  const digest = workflowDigest({ any, cursors });
  const runId = state.script!.runId;
  const prior = state.waits?.find(wait => wait.key === key);
  if (prior && prior.digest !== digest) throw new Error('Wait key conflict; replay the same selectors and member history');
  if (prior?.status === 'ready') {
    if (prior.runId !== runId) emit(state, { type: 'wait_rebound', waitId: prior.id, runId, agentIds: [] });
    return prior;
  }
  if (!prior && (state.waits?.length ?? 0) >= 128) throw new Error('Workflow wait limit reached');
  const reserved = (state.waits ?? []).filter(other => other.id !== prior?.id && other.status === 'waiting'
    && other.runId === runId && other.any.some(arm => arm.kind === 'message')).length;
  if (cursors.length && (state.mailbox?.receipts.length ?? 0) + reserved >= 128) throw new Error('Mailbox receive limit reached');
  const members = [...new Set(cursors.map(cursor => cursor.member))].map(name => member(state, name));
  for (const agent of members) {
    if (agent.activeTurnId || agent.lastTurnId !== memberCursor(state, agent)) throw new Error('Await the member turn before waiting for a message');
    if (agent.wait && (agent.wait.kind !== 'event' || agent.wait.receiptId !== prior?.id)) throw new Error('Member already has a pending receive');
  }
  const agentIds = members.map(agent => agent.agentId);
  let wait = prior;
  if (wait) emit(state, { type: 'wait_rebound', waitId: wait.id, runId, agentIds });
  else {
    const opened: WorkflowWait = { id: randomUUID(), key, digest, runId, any, createdAt: now, status: 'waiting' };
    emit(state, { type: 'wait_opened', wait: opened, agentIds });
    wait = state.waits!.find(item => item.id === opened.id)!;
  }
  settleEventWaits(state, now);
  return wait;
}

/** Earliest ready event wins; declaration order breaks ties. Only its mailbox reserves messages. */
export function settleEventWaits(state: WorkflowView, now: number): boolean {
  if (state.status !== 'active' || state.script?.status !== 'running') return false;
  let changed = false;
  // Taken before any wait settles: settling releases its members, and every wait watching the same quiet group must agree.
  const parked = (state.waits ?? []).some(wait => wait.status === 'waiting' && wait.any.some(arm => arm.kind === 'quiet')) ? parkedMembers(state) : undefined;
  for (const wait of state.waits ?? []) {
    if (wait.status !== 'waiting' || wait.runId !== state.script.runId) continue;
    const ready: Array<{ index: number; arm: Immutable<WorkflowWaitSelector>; at: number; value: unknown }> = [];
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
        const task = taskById(state, arm.taskId);
        if (!task || !['result_ready', 'failed', 'cancelled', 'waiting_input'].includes(task.status)) continue;
        at = Math.max(wait.createdAt, task.attempts.at(-1)?.endedAt ?? now);
        value = { taskId: task.taskId, status: task.status, error: task.error };
      } else if (arm.kind === 'quiet') {
        if (!arm.members.every(name => parked!.has(member(state, name).agentId))) continue;
        at = now;
        value = { members: arm.members };
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
    if (state.agents?.some(agent => agent.wait?.kind === 'event' && agent.wait.receiptId === wait.id)) emit(state, { type: 'wait_released', waitId: wait.id });
    if (selected.arm.kind === 'message') {
      const receipt = receiveMessages(state, selected.arm.member, `@wait/${wait.id}/${selected.index}`, selected.arm);
      selected.value = receiptMessages(state, receipt.id);
    }
    emit(state, { type: 'wait_settled', waitId: wait.id, result: { index: selected.index, kind: selected.arm.kind, value: selected.value } });
    changed = true;
  }
  return changed;
}
