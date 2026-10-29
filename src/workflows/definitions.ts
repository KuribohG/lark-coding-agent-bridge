import { createHash } from 'node:crypto';
import architectureReview from '../../workflow-definitions/architecture-review/workflow.json';
import type { WorkflowDefinition } from './types';

const definitions: readonly WorkflowDefinition[] = [architectureReview as WorkflowDefinition];

export function workflowDefinition(id: string): WorkflowDefinition {
  const definition = definitions.find(item => item.id === id);
  if (!definition) throw new Error(`Unknown workflow plugin: ${id}`);
  if (definition.apiVersion !== 'bridge.workflow/v1' || definition.kind !== 'agent-led'
    || definition.maxConcurrentWorkers < 1 || definition.maxConcurrentWorkers > 2) {
    throw new Error('Invalid built-in workflow definition');
  }
  return structuredClone(definition);
}

export function workflowDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
