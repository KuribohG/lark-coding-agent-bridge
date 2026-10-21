import type { AppPaths } from '../config/app-paths';
import type { AppConfig, TenantBrand } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { paths } from '../config/paths';
import {
  larkCallbackSigningKeys,
  type LarkCallbackSigningKey,
} from './callback-key';
import { TenantTokenProvider } from './tenant-token';

export interface LarkAppCredentials {
  appId: string;
  appSecret: string;
  tenant: TenantBrand;
}

type LarkSecretPaths = Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile'>;

/**
 * Profile-scoped authentication state. The raw app credentials are resolved
 * once, while the tenant token cache and callback keys are shared by every
 * component serving this profile.
 */
export class LarkProfileAuth {
  private credentialsTask?: Promise<LarkAppCredentials>;
  private tenantTokensTask?: Promise<TenantTokenProvider>;
  private callbackKeysTask?: Promise<LarkCallbackSigningKey[]>;

  constructor(
    private readonly cfg: AppConfig,
    private readonly secretPaths: LarkSecretPaths = paths,
  ) {}

  credentials(): Promise<LarkAppCredentials> {
    this.credentialsTask ??= resolveAppSecret(this.cfg, this.secretPaths).then((appSecret) => ({
      appId: this.cfg.accounts.app.id,
      appSecret,
      tenant: this.cfg.accounts.app.tenant,
    }));
    return this.credentialsTask;
  }

  tenantTokens(): Promise<TenantTokenProvider> {
    this.tenantTokensTask ??= this.credentials().then((credentials) =>
      new TenantTokenProvider(credentials),
    );
    return this.tenantTokensTask;
  }

  callbackKeys(): Promise<LarkCallbackSigningKey[]> {
    this.callbackKeysTask ??= this.credentials().then((credentials) =>
      larkCallbackSigningKeys(credentials.appSecret),
    );
    return this.callbackKeysTask;
  }
}
