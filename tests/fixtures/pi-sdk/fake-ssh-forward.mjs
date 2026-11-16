#!/usr/bin/env node
// Stand-in for `ssh`, used by tests/process/workcell-ssh.test.ts. The "remote"
// machine is this one: a command runs locally, and `-L` tunnels a local port to
// the target port so the provider's forwarding path is exercised for real.
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';

const argv = process.argv.slice(2);
const options = [];
let index = 0;
for (; index < argv.length; index += 1) {
  const token = argv[index];
  if (token === '-N' || token === '-T') { options.push(token); continue; }
  if (token === '-o' || token === '-p' || token === '-L') {
    options.push(token, argv[index + 1]);
    index += 1;
    continue;
  }
  break;
}
const rest = argv.slice(index);
const script = rest.at(-1) ?? '';
const destination = rest.at(-2);

function tunnel(spec) {
  const [, localPort, , remotePort] = spec.split(':');
  const server = createServer((client) => {
    const upstream = connect(Number(remotePort), '127.0.0.1');
    client.pipe(upstream).pipe(client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close);
    upstream.on('error', close);
  });
  server.listen(Number(localPort), '127.0.0.1');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  setInterval(() => {}, 1000);
}

if (options.includes('-N')) {
  const spec = options[options.indexOf('-L') + 1];
  if (!spec) process.exit(2);
  tunnel(spec);
} else {
  // A remote command: run it here with the caller's stdin/stdout.
  const child = spawn('/bin/bash', ['-c', script], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  void destination;
}
