import { addArtifact, readArtifact, requiredText, requireState } from '../kernel-state';
import { archiveOf } from '../kernel-store';
import type { WorkflowToolPlugin } from './types';
import { versioned } from './versioned';

/** Reading results by reference and publishing the main agent's context and reports. */
export const artifactTools: WorkflowToolPlugin = {
  id: 'artifacts',
  tools: [
    {
      name: 'read_artifact',
      main: {
        kind: 'read', doc: 'read_artifact(ref)',
        read: (ctx, state, args) => {
          const bound = requireState(state);
          const ref = requiredText(args.ref);
          // The workflow's own artifacts first, archived ones included, then its descendants'.
          for (const owner of [bound, ...ctx.store.descendants(bound)]) {
            if (owner.artifacts.some(artifact => artifact.ref === ref) || archiveOf(owner)?.artifact(ref)) return readArtifact(owner, ref);
          }
          return readArtifact(bound, ref);
        },
      },
      worker: {
        call: (_ctx, state, task, _caller, args) => {
          const ref = requiredText(args.ref);
          if (!task.inputRefs.includes(ref)) throw new Error('Artifact is outside worker input scope');
          return readArtifact(state, ref);
        },
      },
    },
    {
      name: 'publish_artifact',
      main: {
        doc: 'publish_artifact(kind=context|report,text)', ...versioned((ctx, state, args) => {
          const kind = requiredText(args.kind, 100);
          if (!['context', 'report'].includes(kind)) throw new Error('Main artifacts support context and report');
          const artifact = addArtifact(state, kind, requiredText(args.text), ctx.now);
          return { ref: artifact.ref, kind: artifact.kind, digest: artifact.digest };
        }, { allowAfterDeadline: true }),
      },
    },
  ],
};
