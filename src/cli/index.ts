import { AGENT_KINDS } from '../agent/backend-spec';
import { runWorkflow } from './commands/workflow';
import { checkConfig, showConfig, setConfig, unsetConfig, migrateToToml } from './commands/config';
import { Command } from 'commander';
import { dirname } from 'node:path';
import { useBundledLarkCli } from '../platform/bundled-tools';
import { formatAgentPreflightDiagnostic, getAgentPreflightDiagnostic } from '../agent/preflight';
import { runKillCli, runPs } from './commands/ps';
import { runLogs } from './commands/logs';
import {
  runSecretsGet,
  runSecretsList,
  runSecretPut,
  runSecretsRemove,
  runSecretsSet,
} from './commands/secrets';
import {
  runProfileCreate,
  runProfileAutostart,
  runProfileExport,
  runProfileList,
  runProfileRemove,
  runProfileUse,
} from './commands/profile';
import {
  runServiceRestart,
  runServiceStart,
  runServiceStatus,
  runServiceStop,
  runServiceUnregister,
} from './commands/service';
import { runStart } from './commands/start';
import { runUi } from './commands/ui';
import { runWeb } from './commands/web';
import { runSlack } from './commands/slack';
import { configureCiWatch, statusCiWatch } from './commands/ci-watch';
import { checkMonitors, configureMonitors, initMonitors, statusMonitors } from './commands/monitors';
import { checkService, configureService, listServices, removeService } from './commands/model-service';
import { formatBuildVersion } from '../build-info';

const program = new Command();

useBundledLarkCli(import.meta.url);

program
  .name('lark-channel-bridge')
  .description('Bridge Feishu/Lark messenger with local CLI coding agents')
  .version(formatBuildVersion(), '-v, --version');

// === process-level commands (work directly on bridge processes) ===

program
  .command('run')
  .description('Run the bridge in the foreground (was `start` in older versions)')
  .option('-c, --config <path>', 'path to config file')
  .option('--profile <name>', 'profile name to run')
  .option('--web-ui', 'run the machine-wide supervisor + local web console (hosts all profiles); default is a single-profile headless run')
  .option('--agent <kind>', `agent kind for a new profile (${AGENT_KINDS.join(', ')})`)
  .option('--workspace <path>', 'initial working directory for first-run profile bootstrap')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: {
    config?: string;
    profile?: string;
    webUi?: boolean;
    agent?: string;
    workspace?: string;
    appId?: string;
    appSecret?: string;
    tenant?: string;
    skipCheckLarkCli?: boolean;
  }) => {
    await runStart(opts);
  });

program.command('web')
  .option('-c, --config <path>', 'execution defaults and Web presentation from TOML')
  .description('Run standalone browser chat without a Lark account')
  .option('--agent <kind>', `initial engine override (${AGENT_KINDS.join(', ')})`)
  .option('--profile <name>', 'config profile whose default engine and Web settings are used')
  .requiredOption('--workspace <path>', 'workspace for browser conversations')
  .option('--state-dir <path>', 'private conversation state directory')
  .option('--port <port>', 'localhost port; default 8787, use 0 for a free port')
  .option('--binary <path>', 'agent executable')
  .option('--model <id>', 'model for new runs')
  .action(runWeb);

program.command('slack')
  .option('-c, --config <path>', 'TOML file supplying execution and Slack presentation defaults')
  .description('Run a standalone Slack channel over Socket Mode')
  .option('--agent <kind>', `initial engine override (${AGENT_KINDS.join(', ')})`)
  .option('--profile <name>', 'config and secret profile')
  .requiredOption('--workspace <path>', 'workspace for Slack conversations')
  .option('--state-dir <path>', 'private conversation state directory')
  .option('--binary <path>', 'agent executable')
  .option('--model <id>', 'model for new runs')
  .option('--team-id <id>', 'require this Slack workspace/team ID')
  .option('--allowed-users <ids>', 'comma-separated Slack user IDs')
  .option('--allowed-channels <ids>', 'comma-separated Slack channel IDs')
  .option('--allow-all-users', 'allow every human user in the authenticated workspace')
  .option('--show-tools', 'show tool activity in Slack progress')
  .option('--bot-token-env <name>', 'environment variable holding the bot token', 'SLACK_BOT_TOKEN')
  .option('--app-token-env <name>', 'environment variable holding the app-level token', 'SLACK_APP_TOKEN')
  .option('--bot-token-secret <id>', 'keystore ID for the bot token', 'slack-bot-token')
  .option('--app-token-secret <id>', 'keystore ID for the app-level token', 'slack-app-token')
  .action(runSlack);

program.command('workflow <operation>')
  .description('Call the current bridge-owned workflow using this run’s scoped binding')
  .option('--input <json>', 'structured operation arguments')
  .option('--input-file <path>', 'read structured arguments from a JSON file')
  .option('--json', 'return structured JSON')
  .action(runWorkflow);

const config = program.command('config').description('Inspect and edit layered execution and channel configuration');
config.command('check').option('-c, --config <path>').action(checkConfig);
config.command('show').option('-c, --config <path>').option('--profile <name>').option('--sources').action(showConfig);
config.command('set <key> <value>').option('-c, --config <path>').action(setConfig);
config.command('unset <key>').option('-c, --config <path>').action(unsetConfig);
config.command('migrate').option('-c, --config <path>').option('--output <path>').option('--dry-run').action(migrateToToml);

const profile = program
  .command('profile')
  .description('Manage local bridge profiles');

const ciWatch = program.command('ci-watch').description('Configure and inspect GitLab CI failure analysis');
ciWatch.command('configure <file>').option('-c, --config <path>', 'path to bridge root config')
  .description('Load CI watch settings from a JSON file').action(configureCiWatch);
ciWatch.command('status').option('-c, --config <path>', 'path to bridge root config')
  .description('Show configuration and persisted CI analysis state').action(statusCiWatch);

const monitors = program.command('monitors').description('Manage unified Lark and GitLab monitoring in TOML');
monitors.command('init').option('-c, --config <path>', 'path to bridge root config')
  .option('-o, --output <path>', 'new TOML file; defaults to monitors.toml beside the root config')
  .description('Migrate existing monitor settings without changing source switches').action(initMonitors);
monitors.command('configure <file>').option('-c, --config <path>', 'path to bridge root config')
  .description('Use an existing validated TOML file as the monitor configuration').action(configureMonitors);
monitors.command('check [file]').option('-c, --config <path>', 'path to bridge root config')
  .description('Check TOML and profile references without contacting any source').action(checkMonitors);
monitors.command('status').option('-c, --config <path>', 'path to bridge root config')
  .description('Show monitor file location and configured sources').action(statusMonitors);

const modelService = program.command('model-service').description('Manage independent model API services');
modelService.command('list').option('-c, --config <path>', 'path to bridge root config')
  .description('Show model service configuration and credential references').action(listServices);
modelService.command('configure <name> <file>').option('-c, --config <path>', 'path to bridge root config')
  .description('Save a model service from a JSON file').action(configureService);
modelService.command('remove <name>').option('-c, --config <path>', 'path to bridge root config')
  .description('Remove an unused model service').action(removeService);
modelService.command('check <name>').option('-c, --config <path>', 'path to bridge root config')
  .description('Validate local settings and credential access without a model request').action(checkService);

profile
  .command('list')
  .description('List configured profiles')
  .action(async () => {
    await runProfileList();
  });

profile
  .command('create <name>')
  .description('Create a profile from QR registration or existing app credentials')
  .option('--agent <kind>', `agent kind (${AGENT_KINDS.join(', ')})`)
  .option('--workspace <path>', 'initial working directory for this profile')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .action(async (name: string, opts: {
    agent?: string;
    workspace?: string;
    appId?: string;
    appSecret?: string;
    tenant?: string;
  }) => {
    await runProfileCreate(name, opts);
  });

profile
  .command('use <name>')
  .description('Set the active profile')
  .action(async (name: string) => {
    await runProfileUse(name);
  });

profile
  .command('autostart <name> [state]')
  .description('Show or change whether a profile starts with the supervisor service')
  .option('-c, --config <path>', 'root config path')
  .action(async (name: string, state: string | undefined, opts: { config?: string }) => {
    const normalized = state?.toLowerCase();
    if (normalized !== undefined && normalized !== 'on' && normalized !== 'off') {
      throw new Error('state must be on or off');
    }
    await runProfileAutostart(name, normalized === undefined ? undefined : normalized === 'on',
      opts.config ? { rootDir: dirname(opts.config) } : {});
  });

profile
  .command('remove <name>')
  .description('Archive a profile and its local state')
  .option('--purge', 'permanently delete profile state instead of archiving')
  .option('--yes', 'confirm destructive profile deletion')
  .action(async (name: string, opts: { purge?: boolean; yes?: boolean }) => {
    await runProfileRemove(name, { purge: opts.purge, yes: opts.yes });
  });

profile
  .command('export <name>')
  .description('Export one profile as JSON')
  .option('--output <path>', 'write export JSON to a file instead of stdout')
  .option('--force', 'overwrite an existing output file')
  .option('--include-secrets', 'include secret provider configuration and app secret values')
  .option('--yes', 'confirm exporting secrets')
  .action(async (name: string, opts: {
    output?: string;
    force?: boolean;
    includeSecrets?: boolean;
    yes?: boolean;
  }) => {
    await runProfileExport(name, {
      output: opts.output,
      force: opts.force,
      includeSecrets: opts.includeSecrets,
      yes: opts.yes,
    });
  });

program
  .command('ui')
  .description('Open the local web console (config, profiles, online bots) in your browser')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--print', 'print the URL instead of opening a browser')
  .action(async (opts: { profile?: string; print?: boolean }) => {
    await runUi(opts);
  });

program
  .command('ps')
  .description('List running bridge processes on this machine')
  .action(() => {
    runPs();
  });

program
  .command('logs')
  .description('Print recent service logs (and optionally follow them) without platform shell commands')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'read the machine-wide supervisor logs')
  .option('--follow', 'follow appended log output until interrupted')
  .option('--lines <count>', 'initial trailing line count (default 100)', value => Number(value))
  .action(async (opts: { profile?: string; webUi?: boolean; follow?: boolean; lines?: number }) => {
    await runLogs(opts);
  });

program
  .command('kill <target>')
  .description('Kill a running bridge process by short id or list index (SIGTERM, then SIGKILL after 2s). Was `stop <target>` in older versions.')
  .action(async (target: string) => {
    await runKillCli(target);
  });

// === service-level commands (OS-managed daemon: launchd/systemd/schtasks) ===

const requireExplicitServiceTarget = !process.stdin.isTTY || !process.stdout.isTTY;

program
  .command('start')
  .description('Install (if needed) and start the bridge as an OS-managed daemon; Windows uses a current-user ONLOGON task')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'run the supervisor + web console as the background service (hosts all profiles) instead of a single profile')
  .option('--agent <kind>', `agent kind for first-run profile bootstrap (${AGENT_KINDS.join(', ')})`)
  .option('--workspace <path>', 'initial working directory for first-run profile bootstrap')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: {
    profile?: string;
    webUi?: boolean;
    agent?: string;
    workspace?: string;
    appId?: string;
    appSecret?: string;
    tenant?: string;
    skipCheckLarkCli?: boolean;
  }) => {
    await runServiceStart({ ...opts, requireExplicitTarget: requireExplicitServiceTarget });
  });

program
  .command('stop')
  .description('Stop the OS-managed daemon and disable autostart (service definition stays)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service (auto-detected when no per-profile service exists)')
  .action(async (opts: { profile?: string; webUi?: boolean }) => {
    await runServiceStop({ profile: opts.profile, webUi: opts.webUi,
      requireExplicitTarget: requireExplicitServiceTarget });
  });

program
  .command('restart')
  .description('Restart the OS-managed daemon')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service instead of a per-profile one')
  .action(async (opts: { profile?: string; webUi?: boolean }) => {
    await runServiceRestart({ profile: opts.profile, webUi: opts.webUi,
      requireExplicitTarget: requireExplicitServiceTarget });
  });

program
  .command('status')
  .description('Show OS service status (pid, last exit, log paths)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service instead of a per-profile one')
  .option('--json', 'print build, service, runtime and config-revision state as JSON')
  .action(async (opts: { profile?: string; webUi?: boolean; json?: boolean }) => {
    await runServiceStatus({ profile: opts.profile, webUi: opts.webUi,
      json: opts.json, requireExplicitTarget: requireExplicitServiceTarget });
  });

program
  .command('unregister')
  .description('Remove the OS service registration (bootout + delete plist)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service instead of a per-profile one')
  .action(async (opts: { profile?: string; webUi?: boolean }) => {
    await runServiceUnregister({ profile: opts.profile, webUi: opts.webUi,
      requireExplicitTarget: requireExplicitServiceTarget });
  });

const secrets = program
  .command('secrets')
  .description('Manage the bridge\'s encrypted secret keystore (~/.lark-channel/secrets.enc)');

secrets
  .command('get')
  .description('Exec-provider protocol: read JSON request from stdin, write JSON response to stdout. Used by lark-cli config bind --source lark-channel.')
  .action(async () => {
    await runSecretsGet();
  });

secrets
  .command('set')
  .description('Encrypt and store an App Secret. Prompts for the secret without echoing.')
  .requiredOption('--app-id <id>', 'App ID (e.g. cli_xxxxxxxxxxxx)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { appId: string; profile?: string }) => {
    await runSecretsSet(opts.appId, { profile: opts.profile });
  });

secrets
  .command('put <id>')
  .description('Encrypt and store an arbitrary named secret')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (id: string, opts: { profile?: string }) => {
    await runSecretPut(id, { profile: opts.profile });
  });

secrets
  .command('list')
  .description('List the IDs of secrets in the encrypted keystore (no secrets shown)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { profile?: string }) => {
    await runSecretsList({ profile: opts.profile });
  });

secrets
  .command('remove')
  .description('Delete an entry from the encrypted keystore')
  .requiredOption('--app-id <id>', 'App ID to remove')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { appId: string; profile?: string }) => {
    await runSecretsRemove(opts.appId, { profile: opts.profile });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const diagnostic = getAgentPreflightDiagnostic(err);
  if (diagnostic) {
    console.error(formatAgentPreflightDiagnostic(diagnostic));
    process.exit(1);
  }
  if (err instanceof Error) {
    if (err.name === 'UserCancelledError') {
      console.log(err.message);
      process.exit(0);
    }
    console.error(`Error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
