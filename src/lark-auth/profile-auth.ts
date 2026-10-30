import type { AppPaths } from '../config/app-paths';
import type { AppConfig, TenantBrand } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { paths } from '../config/paths';
import {
  larkCallbackSigningKeys,
  type LarkCallbackSigningKey,
} from './callback-key';
import { TenantTokenProvider } from './tenant-token';
import { LarkNetwork } from './network';

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
  private networkValue?: LarkNetwork;
  private networkUsers = 0;
  private closePending = false;

  /** Background consumers can finish after the channel is replaced. */
  retainNetwork(): () => Promise<void> {
    this.networkUsers++;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (--this.networkUsers === 0 && this.closePending) await this.close();
    };
  }

  /** An agent-switch rollback may reactivate this same profile auth object. */
  resumeNetwork(): void { this.closePending = false; }

  get network(): LarkNetwork {
    return this.networkValue ??= new LarkNetwork(this.cfg.channels?.lark?.network);
  }

  readonly request: typeof fetch = (input, init) => this.network.request(input, init);

  async close(): Promise<void> {
    if (this.networkUsers > 0) { this.closePending = true; return; }
    this.closePending = false;
    const network = this.networkValue;
    this.networkValue = undefined;
    await network?.close();
  }

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
      new TenantTokenProvider({ ...credentials, request: this.request }),
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
