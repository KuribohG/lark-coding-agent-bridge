#!/usr/bin/env bash
# Runs the same edits in a wsfs workspace and in a plain Git worktree, and fails when they differ.
#
#   WSFS=<wsfs binary> tests/smoke.sh [<scratch directory>]
#
# The scratch directory holds the test repository, the state and the mount point. It must be on a filesystem
# that takes FUSE mounts and Unix sockets.
set -euo pipefail

WSFS=${WSFS:?the wsfs binary}
SCRATCH=${1:-$(mktemp -d /tmp/wsfs-smoke.XXXXXX)}
REPO=$SCRATCH/repo PLAIN=$SCRATCH/plain STATE=$SCRATCH/state MNT=$SCRATCH/mnt SOCK=$SCRATCH/control
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z
failures=0 daemon=

note() { printf '%s\n' "$*"; }
fail() { failures=$((failures + 1)); printf 'FAIL: %s\n' "$*"; }
check() { local what=$1; shift; if "$@"; then note "ok: $what"; else fail "$what"; fi; }
ctl() { "$WSFS" ctl --control "$SOCK" "$@"; }

start() {
  "$WSFS" mount --repo "$REPO" --state "$STATE" --control "$SOCK" "$MNT" 2>>"$SCRATCH/daemon.log" &
  daemon=$!
  # The daemon listens once it has mounted.
  for _ in $(seq 100); do ctl list >/dev/null 2>&1 && return; sleep 0.1; done
  note "the daemon did not come up"; tail -5 "$SCRATCH/daemon.log"; exit 1
}
stop() {
  [ -n "$daemon" ] || return 0
  ctl shutdown >/dev/null 2>&1 || true
  wait "$daemon" 2>/dev/null || true
  daemon=
}
cleanup() {
  stop
  mountpoint -q "$MNT" 2>/dev/null && fusermount3 -u -z "$MNT" 2>/dev/null || true
}
trap cleanup EXIT

# The two trees, without the Git link, as names, kinds, modes that Git tracks, and content.
snapshot() {
  (cd "$1" && find . -mindepth 1 -not -name .git -printf '%P\t%y\t' \
      \( -type l -printf '%l\n' -o -type f -exec sh -c 'printf "%s\t" "$(test -x "$1" && echo x || echo -)"; sha1sum < "$1"' _ {} \; -o -printf '\n' \) | LC_ALL=C sort)
}
same() {
  local what=$1
  if diff <(snapshot "$PLAIN") <(snapshot "$MNT/w") > "$SCRATCH/tree.diff"; then note "ok: $what: trees match"; else fail "$what: trees differ"; head -20 "$SCRATCH/tree.diff"; fi
  if diff <(git -C "$PLAIN" status --porcelain=v1 -uall) <(git -C "$MNT/w" status --porcelain=v1 -uall) > "$SCRATCH/status.diff"; then
    note "ok: $what: git status matches ($(git -C "$MNT/w" status --porcelain=v1 -uall | wc -l) lines)"
  else fail "$what: git status differs"; head -20 "$SCRATCH/status.diff"; fi
}
# Runs a script in both trees.
both() { for tree in "$PLAIN" "$MNT/w"; do (cd "$tree" && eval "$1") || fail "in $tree: $1"; done; }
upper() { ctl list | python3 -c 'import json,sys; w=[x for x in json.load(sys.stdin)["workspaces"] if x["name"]=="w"][0]; print(w["files"], w["dirs"], w["deleted"])'; }

if [ -e "$SCRATCH" ] && [ -n "$(ls -A "$SCRATCH")" ]; then note "$SCRATCH is not empty"; exit 2; fi
mkdir -p "$REPO" "$STATE" "$MNT"
cd "$REPO"
git init -q -b main .
mkdir -p src/deep/er docs bin empty-after
for i in $(seq 40); do echo "line $i" > "src/f$i.txt"; done
for i in $(seq 10); do echo "deep $i" > "src/deep/d$i.c"; echo "deeper $i" > "src/deep/er/e$i.h"; done
echo '#!/bin/sh' > bin/run; chmod +x bin/run
ln -s ../src/f1.txt docs/link
head -c 300000 /dev/urandom | base64 > docs/big.txt
echo only > empty-after/only.txt
printf 'build/\n*.o\n' > .gitignore
git add -A; git commit -q -m first
FIRST=$(git rev-parse HEAD)
git worktree add -q --detach "$PLAIN" "$FIRST"

start
ctl create name=w base="$FIRST" > "$SCRATCH/create.json" || { cat "$SCRATCH/create.json"; exit 1; }
note "created: $(cat "$SCRATCH/create.json")"
cd "$MNT/w"

check "the workspace is a Git worktree" test "$(git rev-parse HEAD)" = "$FIRST"
same "fresh"
check "git status is clean" test "$(git status --porcelain | wc -l)" = 0
check "git diff HEAD is empty" test -z "$(git diff HEAD --stat)"
check "nothing is the workspace's own yet" test "$(upper)" = "0 0 0"
check "the index names the files" git ls-files --error-unmatch src/f1.txt bin/run docs/link > /dev/null

both 'echo changed >> src/f1.txt; echo new > src/new.txt; rm src/f2.txt; mkdir -p build/x; echo obj > build/x/a.o; echo untracked > loose.txt'
same "edit, add, delete"
both 'mv src/f3.txt src/moved.txt; mv src/deep/d1.c docs/d1.c; chmod +x src/f4.txt; ln -s f5.txt src/l5; rm docs/link; ln -s ../bin/run docs/link'
same "rename, chmod, links"
both 'rm -r src/deep/er; mkdir src/deep/er; echo again > src/deep/er/back.h; rm empty-after/only.txt; rmdir empty-after'
same "directory removed and made again"
both 'mv build built; mkdir -p a/b/c; echo x > a/b/c/x; mv a/b a/q; rm -rf built/x; : > docs/big.txt; printf abc >> docs/big.txt; truncate -s 2 docs/big.txt'
same "own directory moved, truncation"
both 'cp src/f6.txt src/f6.copy; cat src/f7.txt src/f8.txt > src/f78.txt; sed -i s/line/LINE/ src/f9.txt; touch -d 2021-03-04T05:06:07 src/f10.txt'
same "copies and in-place edits"
both 'exec 3< src/f11.txt; rm src/f11.txt; cat <&3 > kept-open.txt; exec 3<&-; echo y > src/f12.txt.tmp; mv src/f12.txt.tmp src/f12.txt'
same "read after unlink, replace by rename"
check "renaming a directory of the commit is refused as across filesystems" sh -c '! python3 -c "import os,sys; os.rename(sys.argv[1], sys.argv[2])" src/deep src/deep2 2>/dev/null'
check "git mv of such a directory fails, as Git does not copy" sh -c 'LC_ALL=C git mv bin bin2 2>&1 | grep -q cross-device'
both 'mv src/deep src/deep2'
same "mv falls back to copy and delete"

both 'git add -A; git commit -q -m second; git status --porcelain'
same "commit"
SECOND=$(git -C "$MNT/w" rev-parse HEAD)
check "both made the same tree" test "$(git -C "$PLAIN" rev-parse HEAD^{tree})" = "$(git -C "$MNT/w" rev-parse HEAD^{tree})"
note "the workspace's own before the move: $(upper)"

# The landing step: the workspace moves to the commit it made, and gives up the files that commit holds.
written=$(stat -c %y "$MNT/w/src/new.txt")
ctl set_base name=w base="$SECOND" > "$SCRATCH/move.json" || { cat "$SCRATCH/move.json"; exit 1; }
note "moved: $(cat "$SCRATCH/move.json")"
same "after the move"
check "a file given up for the same content keeps its time" test "$(stat -c %y "$MNT/w/src/new.txt")" = "$written"
check "only untracked files stay the workspace's own" diff <(cd "$STATE/ws/w/upper" && find . -not -type d -printf '%P\n' | LC_ALL=C sort) <(cd "$PLAIN" && git ls-files -o | LC_ALL=C sort)
check "git status is clean but for untracked files" test -z "$(git -C "$MNT/w" status --porcelain | grep -v '^??')"

# Another commit made elsewhere: the workspace follows it while holding a change of its own.
git -C "$PLAIN" checkout -q --detach "$SECOND"
(cd "$PLAIN" && echo upstream >> src/f20.txt && echo fresh > src/upstream.txt && git rm -q src/f21.txt && git add -A && git commit -q -m third)
THIRD=$(git -C "$PLAIN" rev-parse HEAD)
(cd "$PLAIN" && echo mine >> src/f30.txt); (cd "$MNT/w" && echo mine >> src/f30.txt)
ctl set_base name=w base="$THIRD" mode=keep head=true > "$SCRATCH/keep.json" || { cat "$SCRATCH/keep.json"; exit 1; }
note "followed: $(cat "$SCRATCH/keep.json")"
same "after following with a change kept"
check "the change is still there" grep -q mine "$MNT/w/src/f30.txt"
(cd "$MNT/w" && echo clash >> src/f20.txt)
(cd "$PLAIN" && git stash -q && echo more >> src/f20.txt && git commit -q -am fourth && git stash pop -q)
FOURTH=$(git -C "$PLAIN" rev-parse HEAD)
check "following is refused when both changed a file" sh -c "! '$WSFS' ctl --control '$SOCK' set_base name=w base=$FOURTH mode=keep > '$SCRATCH/refused.json'"
note "refused: $(cat "$SCRATCH/refused.json")"
ctl set_base name=w base="$FOURTH" mode=reset head=true > /dev/null
(cd "$PLAIN" && git reset -q --hard "$FOURTH")
same "after a reset to the fourth commit"

# A move gives the files it changed the time of the move, as Git gives the files it writes, so a build makes
# again what was made from them; files it did not change keep theirs, and Git still reads none to find them clean.
check "a file the move changed is newer than one it did not" test "$MNT/w/src/f20.txt" -nt "$MNT/w/src/f33.txt"
check "git status after the moves reads no file" sh -c "before=\$('$WSFS' ctl --control '$SOCK' stat | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"requests\"][\"read\"])'); git -C '$MNT/w' status --porcelain > /dev/null; after=\$('$WSFS' ctl --control '$SOCK' stat | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"requests\"][\"read\"])'); test \"\$before\" = \"\$after\""

# A Git command that holds the index is not overtaken: the move is refused and changes nothing.
: > "$REPO/.git/worktrees/w/index.lock"
check "a move is refused while Git holds the index" sh -c "! '$WSFS' ctl --control '$SOCK' set_base name=w base=$THIRD > '$SCRATCH/locked.json'"
note "refused: $(cat "$SCRATCH/locked.json")"
check "the refused move left the lock to its holder" test -e "$REPO/.git/worktrees/w/index.lock"
rm "$REPO/.git/worktrees/w/index.lock"
same "after the refused move"
check "a move leaves no lock behind" sh -c "'$WSFS' ctl --control '$SOCK' set_base name=w base=$FOURTH head=true > /dev/null && test ! -e '$REPO/.git/worktrees/w/index.lock'"
check "the move is in the reflog" sh -c "git -C '$MNT/w' reflog -3 --format=%gs | grep -q 'wsfs: moving to'"

# What a workspace holds is on disk: a daemon that starts again finds it.
(cd "$PLAIN" && echo survive > src/f31.txt && rm src/f32.txt); (cd "$MNT/w" && echo survive > src/f31.txt && rm src/f32.txt)
cd /; stop; start
same "after the daemon started again"
kill -9 "$daemon"; wait "$daemon" 2>/dev/null || true; daemon=
start
same "after the daemon was killed and started again"

ctl stat
ctl remove name=w > /dev/null
check "the workspace is gone" test ! -e "$MNT/w"
check "its worktree record is gone" test ! -e "$REPO/.git/worktrees/w"
stop
note "failures: $failures"
exit $((failures > 0))
