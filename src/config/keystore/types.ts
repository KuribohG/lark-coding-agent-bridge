import type { AppPaths } from '../app-paths';

export type KeystorePaths = Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile'>;

export type KeystoreKeyId = 'env-v2' | 'local-v2' | 'legacy-v1';

export interface SecretEnvelope {
  keyId: KeystoreKeyId;
  /** base64 of a 12-byte IV. */
  iv: string;
  /** base64 ciphertext. */
  data: string;
  /** base64 16-byte GCM authentication tag. */
  tag: string;
}

export interface SecretStoreFile {
  version: 2;
  entries: Record<string, SecretEnvelope>;
}

export interface SecretStore {
  read(): Promise<SecretStoreFile>;
  write(store: SecretStoreFile): Promise<void>;
}

export interface SecretKeyMaterial {
  id: KeystoreKeyId;
  key: Buffer;
}

export interface SecretKeyProvider {
  activeKey(): Promise<SecretKeyMaterial>;
  keyFor(id: KeystoreKeyId): Promise<SecretKeyMaterial>;
}

export interface KeystoreRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  username?: string;
}

export type KeystoreErrorCode =
  | 'invalid-salt'
  | 'invalid-store'
  | 'missing-key'
  | 'decrypt-failed';

export class KeystoreError extends Error {
  constructor(
    readonly code: KeystoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'KeystoreError';
  }
}
