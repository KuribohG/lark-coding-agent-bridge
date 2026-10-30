# architecture-review 0.2.0-p0

Static agent-led workflow: two independent designers, followed by an optional challenger and a main-agent decision report. The main agent owns planning and follow-up; the kernel owns execution and lifecycle.

Each delegated actor may select a different harness through `execution.agentKind`, with optional `model` and `reasoningEffort`. Execution stays within the root's authorized profile. The binding and native session remain fixed for follow-ups; changing the harness requires a new actor. Version 0.2.0 adds cross-harness bindings and Pi final-answer events; older deployed builds do not support this contract.

This P0 definition uses text artifacts. It deliberately has a separate version from the full structured proposal: requirement revisions, verifier execution and recovery are not available yet. See [the workflow contract](../../docs/workflows.md).
