import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { profileForAgentKind } from '../../../src/runtime/execution-controller';
import { resolveWorkerExecution, workerSelection } from '../../../src/workflows/execution';
import type { WorkflowRoot } from '../../../src/workflows/types';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';

const root: WorkflowRoot = { scopeId: 'topic', profile: 'codex', agentKind: 'codex', cwdRealpath: '/workspace',
  policyFingerprint: 'root-policy', catalogBinding: 'root-thread', modelSettings: { model: 'codex-model' } };
const policy: RunPolicyAllow = { ok: true, prompt: '', requestedCwd: '/workspace', cwdRealpath: '/workspace',
  accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions',
  access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'root-policy', expiresAt: Date.now() + 60000 };
const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex' },
  accounts: { app: { id: 'test', secret: 'test', tenant: 'feishu' } } });

describe('worker execution binding', () => {
  it('keeps authorization and profile while independently binding the Pi backend and model', () => {
    const target = profileForAgentKind(profile, 'pi');
    target.permissions = { ...target.permissions, maxAccess: 'full' };
    const resolved = resolveWorkerExecution(root, target, policy, { model: 'pi-model' });
    expect(resolved.execution).toMatchObject({ profile: 'codex', agentKind: 'pi', modelSettings: { model: 'pi-model' } });
    expect(resolved.policy).toMatchObject({ cwdRealpath: '/workspace', accessMode: 'full', access: policy.access });
    expect(root.modelSettings.model).toBe('codex-model');
    expect(JSON.stringify(resolved)).not.toContain('binaryPath');
    expect(resolveWorkerExecution(root, { ...target, pi: { ...target.pi!, binaryPath: 'replacement-pi' } }, policy, { model: 'pi-model' })
      .execution.configurationFingerprint).not.toBe(resolved.execution.configurationFingerprint);
  });

  it('does not widen root access and rejects an unsupported workspace sandbox', () => {
    const target = profileForAgentKind(profile, 'pi');
    expect(resolveWorkerExecution(root, target, { ...policy, accessMode: 'read-only' }, {}).policy)
      .toMatchObject({ accessMode: 'read-only', sandbox: 'read-only' });
    expect(() => resolveWorkerExecution(root, target, { ...policy, accessMode: 'workspace' }, {})).toThrow('does not support workspace');
  });

  it.each([null, [], 'pi', { agentKind: 'unknown' }, { profile: 'another-profile' }, { env: { KEY: 'value' } },
    { model: '' }, { model: 'default' }, { agentKind: 'pi', reasoningEffort: 'ultra' }])('rejects invalid or out-of-scope selection %j', value => {
    expect(() => workerSelection(value, root)).toThrow();
  });
});
