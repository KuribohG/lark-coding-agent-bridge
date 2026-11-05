export type AccessMode = 'read-only' | 'workspace' | 'full';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export interface PermissionConfig {
  defaultAccess: AccessMode;
  maxAccess: AccessMode;
  claude?: {
    permissionMode?: ClaudePermissionMode;
  };
}

const ACCESS_ORDER: Record<AccessMode, number> = {
  'read-only': 0,
  workspace: 1,
  full: 2,
};

const CLAUDE_PERMISSION_ACCESS: Record<ClaudePermissionMode, AccessMode> = {
  plan: 'read-only',
  default: 'workspace',
  acceptEdits: 'workspace',
  bypassPermissions: 'full',
};

export function normalizePermissions(
  input: Partial<PermissionConfig> | undefined,
): PermissionConfig {
  return input === undefined ? defaultPermissions() : normalizeCanonicalPermissions(input);
}

function assertAccessPair(defaultAccess: AccessMode, maxAccess: AccessMode): void {
  if (ACCESS_ORDER[defaultAccess] > ACCESS_ORDER[maxAccess]) {
    throw new Error('permission defaultAccess cannot exceed maxAccess');
  }
}

export function clampAccess(
  defaultAccess: AccessMode,
  profileMax: AccessMode,
  capabilityMax: AccessMode,
): AccessMode {
  const maxAllowed =
    ACCESS_ORDER[profileMax] < ACCESS_ORDER[capabilityMax] ? profileMax : capabilityMax;
  return ACCESS_ORDER[defaultAccess] <= ACCESS_ORDER[maxAllowed] ? defaultAccess : maxAllowed;
}

export function accessToCodexSandbox(access: AccessMode): CodexSandboxMode {
  switch (access) {
    case 'read-only':
      return 'read-only';
    case 'workspace':
      return 'workspace-write';
    case 'full':
      return 'danger-full-access';
  }
}

export function accessToClaudePermissionMode(
  access: AccessMode,
  permissions?: PermissionConfig,
): ClaudePermissionMode {
  const override = permissions?.claude?.permissionMode;
  if (
    override &&
    ACCESS_ORDER[CLAUDE_PERMISSION_ACCESS[override]] <= ACCESS_ORDER[access]
  ) {
    return override;
  }

  return accessToDefaultClaudePermissionMode(access);
}

function accessToDefaultClaudePermissionMode(access: AccessMode): ClaudePermissionMode {
  switch (access) {
    case 'read-only':
      return 'plan';
    case 'workspace':
      return 'acceptEdits';
    case 'full':
      return 'bypassPermissions';
  }
}

function normalizeCanonicalPermissions(input: Partial<PermissionConfig>): PermissionConfig {
  if (!isConfigObject(input)) {
    throw new Error('invalid permission config');
  }

  const explicitMaxAccess = readAccess(input.maxAccess, 'maxAccess');
  const explicitDefaultAccess = readAccess(input.defaultAccess, 'defaultAccess');
  const maxAccess = explicitMaxAccess ?? 'full';
  const defaultAccess = explicitDefaultAccess ?? maxAccess;
  assertAccessPair(defaultAccess, maxAccess);

  const claude = normalizeClaudePermissions(input.claude);
  if (claude?.permissionMode) {
    assertClaudePermissionWithinAccess(claude.permissionMode, maxAccess);
  }
  return {
    defaultAccess,
    maxAccess,
    ...(claude ? { claude } : {}),
  };
}

function defaultPermissions(): PermissionConfig {
  return {
    defaultAccess: 'full',
    maxAccess: 'full',
  };
}

function assertClaudePermissionWithinAccess(
  permissionMode: ClaudePermissionMode,
  maxAccess: AccessMode,
): void {
  if (ACCESS_ORDER[CLAUDE_PERMISSION_ACCESS[permissionMode]] > ACCESS_ORDER[maxAccess]) {
    throw new Error('permission claude.permissionMode cannot exceed maxAccess');
  }
}

function normalizeClaudePermissions(
  input: PermissionConfig['claude'] | undefined,
): PermissionConfig['claude'] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isConfigObject(input)) {
    throw new Error('invalid permission claude config');
  }
  if (input.permissionMode === undefined) {
    return undefined;
  }
  if (!isClaudePermissionMode(input.permissionMode)) {
    throw new Error('invalid permission claude.permissionMode');
  }
  return {
    permissionMode: input.permissionMode,
  };
}

function readAccess(value: unknown, field: string): AccessMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isAccessMode(value)) {
    throw new Error(`invalid permission ${field}`);
  }
  return value;
}

function isAccessMode(value: unknown): value is AccessMode {
  return value === 'read-only' || value === 'workspace' || value === 'full';
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return (
    value === 'default' ||
    value === 'acceptEdits' ||
    value === 'bypassPermissions' ||
    value === 'plan'
  );
}
