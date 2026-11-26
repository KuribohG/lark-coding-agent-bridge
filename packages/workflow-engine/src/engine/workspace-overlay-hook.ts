/**
 * The fsmonitor hook (protocol version 2) of an overlay workspace, as the text of a Node script. Git runs it from the
 * workspace's top directory with the token it was last given, and takes the answer as the paths that may have changed
 * since: it then looks at those files only, where it would otherwise stat every tracked file through the mount.
 *
 * Whatever differs from the base tree is in the overlay's upper directory, so that directory is listed and the base
 * is never read. A file that exists only there leaves nothing behind when it is deleted or renamed away, so each
 * listing is kept under its token, and what the listing Git last saw had and this one lacks is reported as well. A
 * token this script has no listing for is answered with "/", which tells Git to trust nothing.
 *
 * Paths are handled as latin1 strings, one character for each byte, so names that are not UTF-8 pass through intact.
 */
/** The token the hook gives in a base tree, and the one a template index names: everything in it is as the base has it. */
export const BASE_TOKEN = 'base';
export const FSMONITOR_HOOK = String.raw`'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const KEPT = 32, TOKEN = /^[0-9a-f]{40}$/;
const bytes = (utf8, raw) => Buffer.concat([Buffer.from(utf8), Buffer.from(raw, 'latin1')]);
const answer = (token, paths) => process.stdout.write(Buffer.from(token + '\0' + paths.map(name => name + '\0').join(''), 'latin1'));

function place() {
  try {
    const link = /^gitdir: (.+)$/m.exec(fs.readFileSync('.git', 'utf8'));
    const git = link && path.resolve(link[1].trim());
    return git ? { git, ...JSON.parse(fs.readFileSync(path.join(git, 'bridge-overlay'), 'utf8')) } : undefined;
  } catch (error) { return undefined; }
}

function listing(upper, lower) {
  const found = new Set(), pending = [''];
  // A directory in the upper layer stands for the base's directory of that name, unless the base has a file there.
  const replaces = at => { try { return !fs.lstatSync(bytes(lower, '/' + at)).isDirectory(); } catch (error) { return false; } };
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(bytes(upper, dir && '/' + dir), { withFileTypes: true, encoding: 'buffer' })) {
      const name = entry.name.toString('latin1'), at = dir ? dir + '/' + name : name;
      if (!dir && name === '.git') continue;
      if (name === '.wh..wh..opq') found.add(dir + '/');
      else if (name.startsWith('.wh.') || entry.isCharacterDevice()) {
        // A whiteout, kept as a ".wh." file or as a 0/0 device: the base's file or directory of that name is gone.
        const gone = name.startsWith('.wh.') ? (dir ? dir + '/' : '') + name.slice(4) : at;
        found.add(gone); found.add(gone + '/');
      } else if (entry.isDirectory()) { if (replaces(at)) found.add(at); pending.push(at); }
      else found.add(at);
    }
  }
  return [...found].sort();
}

function main() {
  if (process.argv[2] !== '2') process.exit(1);
  const here = place(), seen = process.argv[3] || '';
  // The base tree itself, where the template index is made: nothing differs from it.
  if (!here) return answer('${BASE_TOKEN}', []);
  const now = listing(here.upper, here.lower), store = path.join(here.git, 'bridge-overlay-fsmonitor');
  const token = crypto.createHash('sha1').update(now.join('\0'), 'latin1').digest('hex');
  const recent = new Date();
  if (!fs.existsSync(path.join(store, token))) {
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, token + '.' + process.pid), now.join('\0'), 'latin1');
    fs.renameSync(path.join(store, token + '.' + process.pid), path.join(store, token));
    const kept = fs.readdirSync(store).filter(name => TOKEN.test(name))
      .map(name => { try { return { name, used: fs.statSync(path.join(store, name)).mtimeMs }; } catch (error) { return undefined; } })
      .filter(Boolean).sort((a, b) => b.used - a.used);
    for (const old of kept.slice(KEPT)) { try { fs.unlinkSync(path.join(store, old.name)); } catch (error) { /* another run removed it */ } }
  }
  let before = [];
  if (seen !== '${BASE_TOKEN}' && seen !== token) {
    try {
      if (!TOKEN.test(seen)) throw new Error('unknown token');
      before = fs.readFileSync(path.join(store, seen), 'latin1').split('\0').filter(Boolean);
      // The index keeps a token until Git next writes it: the listing it names must outlive newer ones nobody refers to.
      fs.utimesSync(path.join(store, seen), recent, recent);
    } catch (error) { before = ['/']; }
  }
  answer(token, [...new Set(now.concat(before))]);
}
main();
`;
