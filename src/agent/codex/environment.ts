import { mergeProcessEnv } from '../../platform/spawn';

export interface CodexToolEnvironment {
  inherit: 'all';
  set: Record<string, string>;
  exclude: string[];
}

/**
 * Profile and attempt bindings belong to tools, regardless of which process
 * owns the shell. Backend credentials belong only to the process launch.
 */
export function codexExecutionEnvironment(input: {
  profile: Readonly<NodeJS.ProcessEnv>;
  attempt?: Readonly<Record<string, string>>;
  backend: Readonly<NodeJS.ProcessEnv>;
  inherited?: Readonly<NodeJS.ProcessEnv>;
}) {
  const overrides = { ...input.profile };
  for (const [key, value] of Object.entries(input.attempt ?? {})) {
    for (const existing of Object.keys(overrides)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete overrides[existing];
    }
    overrides[key] = value;
  }
  const tools: CodexToolEnvironment = { inherit: 'all', set: {}, exclude: [] };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) tools.exclude.push(key);
    else tools.set[key] = value;
  }
  const process = mergeProcessEnv(
    mergeProcessEnv(input.inherited ?? globalThis.process.env, input.profile), input.backend,
  );
  return { process, tools };
}
