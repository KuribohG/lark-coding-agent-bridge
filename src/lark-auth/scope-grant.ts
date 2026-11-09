import { registerApp } from '@larksuite/channel';

export interface ScopeGrantLink {
  /** Authorization URL — opening it lands on the confirm page with the new
   * scopes pre-filled as a diff against the existing app. */
  url: string;
  /** Seconds until the link expires. */
  expireIn: number;
  /** Resolves once the user finishes re-authorizing; rejects on
   * expiry/abort/error. Detached callers can await this to confirm success. */
  completion: Promise<void>;
}

/**
 * Build an incremental-scope authorization link for an EXISTING app via
 * `registerApp({ appId, addons })`. Unlike the CLI registration wizard
 * (terminal QR for first-time creation), this is for the in-chat `/config`
 * flow: we surface the URL the moment it's ready and push it to the user.
 *
 * The returned `completion` promise resolves only after the user authorizes,
 * so callers can `void`-await it to send a follow-up confirmation.
 *
 * Domain is intentionally left unset — `registerApp` defaults to the Feishu
 * auth host and auto-switches to Lark for international tenants (same as
 * the CLI registration wizard), so callers don't pass a tenant.
 */
export async function requestScopeGrantLink(opts: {
  appId: string;
  /** App-identity (tenant) scopes to request, e.g. `['im:message.group_msg']`. */
  tenantScopes: string[];
  signal?: AbortSignal;
}): Promise<ScopeGrantLink> {
  return new Promise<ScopeGrantLink>((resolve, reject) => {
    let urlDelivered = false;
    // registerApp returns synchronously and fires onQRCodeReady later, so
    // `completion` is assigned before the callback can reference it.
    const completion = registerApp({
      source: 'lark-channel-bridge',
      appId: opts.appId,
      addons: { scopes: { tenant: opts.tenantScopes } },
      ...(opts.signal ? { signal: opts.signal } : {}),
      onQRCodeReady: (info) => {
        urlDelivered = true;
        resolve({ url: info.url, expireIn: info.expireIn, completion });
      },
    }).then(() => undefined);
    // If registerApp rejects before ever delivering a URL (e.g. the initial
    // `begin` request fails), surface that failure to the caller.
    completion.catch((err) => {
      if (!urlDelivered) reject(err);
    });
  });
}
