import { resolveAppPaths } from './app-paths';

const appPaths = resolveAppPaths();

export const paths = {
  ...appPaths,
  appDir: appPaths.rootDir,
  cacheDir: appPaths.rootDir,
  processesFile: appPaths.userRegistryFile,
  /**
   * Thin shell wrapper that lark-cli and other exec-provider consumers invoke
   * to resolve secrets from the bridge's encrypted store.
   * Written user-owned and non-symlinked so it passes lark-cli's
   * AssertSecurePath audit on machines where `node` is a Homebrew/Volta
   * symlink or root-owned (`/usr/bin/node`). Wrapper internals do the
   * `node ... secrets get` invocation; lark-cli only audits the wrapper.
   */
};
