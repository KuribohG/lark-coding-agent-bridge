/** Guest-only composition: members coordinate on the shared board; the script only wakes whoever a post names
 * and stops once every member is asleep with nothing left to read. Each member runs its own wake loop, so a
 * slow member never delays the others, and every await in a loop has a key of its own, so replay is stable. */
export const TEAM_HELPER = `
  const teamKeys = new Set();
  globalThis.team = async (task, options) => {
    if (typeof task !== 'string' || !task.trim() || task.length > 16000) throw new TypeError('team needs a task of 1–16000 characters');
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['key','members','maxTurns','onError'].includes(key))) throw new TypeError('Invalid team options');
    const key = options.key;
    const mode = failureMode(options);
    if (typeof key !== 'string' || !key.trim() || key !== key.trim() || key.length > 80 || key.startsWith('@')) throw new TypeError('team key must be 1–80 characters and cannot start with @');
    if (teamKeys.has(key)) throw new Error('Duplicate team key');
    if (!Array.isArray(options.members) || options.members.length < 2 || options.members.length > 12) throw new TypeError('team needs 2–12 members');
    const members = options.members.map(spec => {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)
        || Object.keys(spec).some(field => !['name','role','harness','model','reasoningEffort','workflowTool','workspace'].includes(field))) throw new TypeError('Invalid team member');
      if (typeof spec.name !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(spec.name) || ['all','main','script'].includes(spec.name)) throw new TypeError('team member names use 1–40 letters, digits, _, . or -, and cannot be all, main or script');
      if (spec.role !== undefined && (typeof spec.role !== 'string' || spec.role.length > 2000)) throw new TypeError('team member role must be at most 2000 characters');
      const { name, role, ...execution } = spec;
      return { name, role, execution };
    });
    const names = members.map(member => member.name);
    if (new Set(names).size !== names.length) throw new TypeError('team member names must be unique');
    const maxTurns = options.maxTurns === undefined ? 6 : options.maxTurns;
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 24) throw new TypeError('maxTurns must be 1–24');
    // Every turn is one agent call and one wait; keep within a script run's call budgets.
    if (names.length * (maxTurns + 2) > 120) throw new TypeError('Too many members or turns for one team; reduce members or maxTurns');
    teamKeys.add(key);
    try {
      const roster = members.map(member => '@' + member.name + (member.role ? ' — ' + member.role : '')).join('\\n');
      const rules = 'How the team works:\\n'
        + '- The board is one ordered feed that every member can read. Post with post_board and name who must act in "to" (member names, or "all"); read with read_board.\\n'
        + '- Your turn ends with your final answer. You then sleep at no cost and are woken only when a post names you; those posts arrive in read_context (member.messages).\\n'
        + '- Post results, questions, hand-offs and blockers that others need, with enough detail to act on. Do not post acknowledgements or thanks: every post that names a member costs that member a turn.\\n'
        + '- When you need nothing from anyone and have nothing to report, end the turn without posting. The team finishes when everyone is asleep.\\n'
        + '- Save a checkpoint of your working state before ending a turn. Your final answer is a short status note for the workflow log; teammates only see board posts.';
      const brief = await mail(JSON.stringify({ kind: 'post', key: key + '/brief', text: 'Team "' + key + '" task:\\n' + (task.length > 3800 ? task.slice(0, 3800) + '…[truncated]' : task) })).then(JSON.parse);
      let aborted;
      const run = async member => {
        const name = member.name;
        let turns = 0;
        let note = null;
        const speak = (prompt, stage) => agent(prompt, { ...member.execution, member: name, key: key + '/' + name + '/' + stage, onError: 'throw' });
        try {
          note = await speak('You are member "' + name + '" of team "' + key + '", which coordinates through a shared message board.'
            + (member.role ? '\\nYour role: ' + member.role : '') + '\\nTeam:\\n' + roster + '\\nTask:\\n' + task + '\\n' + rules
            + '\\nThis is your first turn. Start on your part of the task now; if your role only reacts to others, end the turn with a one-line note.', 'open');
          for (let turn = 1; ; turn++) {
            // A member out of turns listens on a topic nobody posts to: it stays asleep and can no longer be woken.
            const spent = turn > maxTurns;
            const event = await waitFor({ key: key + '/' + name + '/wait' + turn,
              any: [{ kind: 'message', member: name, ...(spent ? { topic: key + '/closed' } : {}) }, { kind: 'quiet', members: names }] });
            if (aborted) return { name, turns, stop: 'aborted', note };
            if (event.kind === 'quiet') return { name, turns, stop: spent ? 'max_turns' : 'quiet', note };
            note = await speak('Team "' + key + '", turn ' + turn + ' of at most ' + maxTurns + ' after your first: board posts that name you are in read_context (member.messages). '
              + 'Act on them, use read_board for wider context, and post what others need. End with a short status note.', 'turn' + turn);
            turns++;
          }
        } catch (error) {
          const reason = error && error.message ? error.message : String(error);
          if (error && error.name === 'WorkflowAgentFailure') {
            try { progress('log', 'team ' + key + ': member ' + name + ' failed: ' + reason); } catch {}
            return { name, turns, stop: 'failed', note, error: reason };
          }
          // Anything else leaves this member neither asleep nor failed, so wake the others to stop instead of waiting forever.
          if (!aborted) {
            aborted = error;
            await mail(JSON.stringify({ kind: 'post', key: key + '/abort', to: 'all', text: 'Team "' + key + '" is stopping: ' + reason.slice(0, 500) })).catch(() => undefined);
          }
          return { name, turns, stop: 'aborted', note, error: reason };
        }
      };
      phase('Team ' + key + ': ' + names.length + ' members');
      const results = await strictParallel(members.map(member => () => run(member)));
      if (aborted) throw aborted;
      const board = await mail(JSON.stringify({ kind: 'board', key: key + '/board', after: brief.seq - 1, limit: 50 })).then(JSON.parse);
      const stop = results.some(result => result.stop === 'failed') ? 'failed' : results.some(result => result.stop === 'max_turns') ? 'max_turns' : 'quiet';
      return { stop, turns: results.reduce((sum, result) => sum + result.turns, 0), members: results, posts: board.posts, lastSeq: board.lastSeq, hasMore: board.hasMore };
    } catch (error) { return softFailure(mode, 'team ' + key, error); }
  };
`;
