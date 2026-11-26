#!/usr/bin/env bash
# Times wsfs on a large repository. Usage: bench.sh <phase>...
#
#   WSFS   the wsfs binary
#   REPO   the repository to serve (a `git clone --shared --no-checkout` of the real one keeps it untouched)
#   STATE  where workspaces keep what differs
#   MNT    the mount point
#   SOCK   the control socket, on a filesystem that has Unix sockets
#   LOG    a directory for the daemon's log
#   TIP    the commit to work at; TIP~300 must exist
#   N      how many more workspaces `more` opens (24)
set -u
WSFS=${WSFS:?} REPO=${REPO:?} STATE=${STATE:?} MNT=${MNT:?} SOCK=${SOCK:?} LOG=${LOG:?} TIP=${TIP:?}
N=${N:-24}
export GIT_AUTHOR_NAME=probe GIT_AUTHOR_EMAIL=probe@example.invalid GIT_COMMITTER_NAME=probe GIT_COMMITTER_EMAIL=probe@example.invalid

now() { date +%s.%N; }
t() { # t <label> <command...>: run, print wall time
  local label=$1; shift
  local s e rc; s=$(now); "$@"; rc=$?; e=$(now)
  awk -v l="$label" -v s="$s" -v e="$e" -v rc="$rc" 'BEGIN { printf "[ws] %s: %.2f s (rc=%d)\n", l, e - s, rc }'
  return $rc
}
since() { awk -v l="$1" -v s="$2" -v e="$(now)" 'BEGIN { printf "[ws] %s: %.2f s\n", l, e - s }'; }
q() { "$@" > /dev/null 2>&1; }
count() { "$@" 2> /dev/null | wc -l; }
ctl() { "$WSFS" ctl --control "$SOCK" "$@"; }
rev() { git -C "$REPO" rev-parse --verify "$1^{commit}"; }
own() { ctl list | python3 -c 'import json,sys; w=[x for x in json.load(sys.stdin)["workspaces"] if x["name"]==sys.argv[1]]; print("%d files, %d dirs, %d deletions, %d nodes" % (w[0]["files"], w[0]["dirs"], w[0]["deleted"], w[0]["nodes"]) if w else "no such workspace")' "$1"; }
daemon() { pgrep -f "wsfs mount .*$MNT\$" | head -1; }
rss() { local p; p=$(daemon); [ -n "$p" ] && awk '/VmRSS|Threads/ { printf "%s %s %s  ", $1, $2, $3 }' "/proc/$p/status"; echo; }
up() {
  setsid nohup "$WSFS" mount --repo "$REPO" --state "$STATE" --control "$SOCK" "$MNT" >> "$LOG/daemon.log" 2>&1 < /dev/null &
  for _ in $(seq 300); do ctl list > /dev/null 2>&1 && return 0; sleep 0.1; done
  echo "[ws] the daemon did not come up"; tail -5 "$LOG/daemon.log"; return 1
}

for phase in "$@"; do
echo "=== phase $phase $(date '+%H:%M:%S') load $(cut -d' ' -f1-3 /proc/loadavg)"
case $phase in
mount)
  mkdir -p "$STATE" "$MNT" "$LOG"
  t "mount" up
  echo "[ws] daemon pid $(daemon); $(rss)"
  ;;
open)
  t "create ws0" ctl create name=ws0 base="$(rev "$TIP")"
  W=$MNT/ws0
  t "ls of the root (first access)" q ls "$W"
  t "git status #1 (nothing warmed)" q git -C "$W" status --porcelain
  t "git status #2" q git -C "$W" status --porcelain
  t "git status #3" q git -C "$W" status --porcelain
  echo "[ws] status lines: $(count git -C "$W" status --porcelain); tracked files: $(count git -C "$W" ls-files)"
  t "git add -A (nothing changed) #1" q git -C "$W" add -A
  t "git add -A (nothing changed) #2" q git -C "$W" add -A
  t "git diff HEAD --stat #1" q git -C "$W" diff HEAD --stat
  t "git diff HEAD --stat #2" q git -C "$W" diff HEAD --stat
  t "find . -type f" q find "$W" -type f
  echo "[ws] files found: $(find "$W" -type f | wc -l); own: $(own ws0); daemon: $(rss)"
  ;;
warm) # a second workspace, walked by the daemon before anything looks at it
  t "create ws-warm" ctl create name=ws-warm base="$(rev "$TIP")"
  t "warm ws-warm" ctl warm name=ws-warm
  W=$MNT/ws-warm
  t "git status #1 (warmed)" q git -C "$W" status --porcelain
  t "git status #2" q git -C "$W" status --porcelain
  t "git add -A #1" q git -C "$W" add -A
  t "git diff HEAD --stat #1" q git -C "$W" diff HEAD --stat
  echo "[ws] daemon: $(rss)"
  ;;
edit)
  W=$MNT/ws0
  f=$(git -C "$W" ls-files 'src/*.cpp' | head -1)
  echo "// probe" >> "$W/$f"; echo "// new" > "$W/src/probe_new.cpp"
  t "git status after an edit and a new file" git -C "$W" status --porcelain
  t "git diff --stat" q git -C "$W" diff --stat
  t "git add of two paths" git -C "$W" add "$f" src/probe_new.cpp
  echo "[ws] own before commit: $(own ws0)"
  t "git commit" git -C "$W" commit -q -m probe
  echo "[ws] own after commit: $(own ws0)"
  t "move ws0 to the commit it made" ctl set_base name=ws0 base="$(git -C "$W" rev-parse HEAD)"
  echo "[ws] own after the move: $(own ws0)"
  t "git status after the move" git -C "$W" status --porcelain
  ;;
more)
  base=$(rev "$TIP"); s=$(now)
  pids=(); for i in $(seq 1 "$N"); do ( q ctl create name="ws$i" base="$base" ) & pids+=($!); done; wait "${pids[@]}"
  since "create $N more at once" "$s"
  for round in "nothing warmed" "again" "a third time"; do
    s=$(now)
    pids=(); for i in $(seq 1 "$N"); do ( q git -C "$MNT/ws$i" status --porcelain ) & pids+=($!); done; wait "${pids[@]}"
    since "git status in all $N at once, $round" "$s"
  done
  t "git add -A in ws$N (first)" q git -C "$MNT/ws$N" add -A
  t "git diff HEAD --stat in ws$N (first)" q git -C "$MNT/ws$N" diff HEAD --stat
  echo "[ws] daemon: $(rss); $(ctl stat)"
  ;;
content)
  W=$MNT/ws0
  t "read every file of ws0 once (16 readers)" timeout 480 bash -c "find '$W' -type f -not -name .git -print0 | xargs -0 -n 256 -P 16 cat | wc -c"
  t "read every file of ws0 again" timeout 480 bash -c "find '$W' -type f -not -name .git -print0 | xargs -0 -n 256 -P 16 cat | wc -c"
  echo "[ws] daemon: $(rss)"
  ;;
drift) # following a branch: by the daemon moving the workspace, and by Git writing the files
  for how in move git; do
    B=drift-$how; W=$MNT/$B
    t "create $B at TIP~300" ctl create name="$B" base="$(rev "$TIP~300")"
    t "git status at its start" q git -C "$W" status --porcelain
    prev=$TIP~300
    for target in "$TIP~100" "$TIP~5" "$TIP"; do
      n=$(git -C "$REPO" diff --name-only "$prev" "$target" | wc -l)
      if [ $how = move ]; then
        t "move to $target ($n paths differ)" ctl set_base name="$B" base="$(rev "$target")" head=true
      else
        t "git reset --hard to $target ($n paths differ)" q git -C "$W" reset --hard "$target"
      fi
      echo "[ws]   own right after: $(own "$B")"
      t "  git status right after" q git -C "$W" status --porcelain
      t "  git diff HEAD --stat" q git -C "$W" diff HEAD --stat
      prev=$target
    done
    echo "[ws] status lines at the end: $(count git -C "$W" status --porcelain); HEAD $(git -C "$W" rev-parse --short HEAD); daemon: $(rss)"
    if [ $how = git ]; then
      t "move drift-git to where it is, to give up what the commit holds" ctl set_base name="$B" base="$(rev "$TIP")"
      echo "[ws]   own after: $(own "$B"); status lines: $(count git -C "$W" status --porcelain)"
    fi
  done
  ;;
landing) # a member's commit is rebased onto the target without a checkout, then the workspace moves to it
  B=land; W=$MNT/$B
  t "create $B at TIP~5" ctl create name="$B" base="$(rev "$TIP~5")"
  mkdir -p "$W/src" && echo "// member work" > "$W/src/member_work.cpp"
  f=$(git -C "$W" ls-files 'src/*.cpp' | sed -n 3p); echo "// member edit" >> "$W/$f"
  q git -C "$W" add -A; q git -C "$W" commit -q -m "member work"
  member=$(git -C "$W" rev-parse HEAD)
  echo "[ws] own after the member's commit: $(own "$B")"
  s=$(now)
  tree=$(git -C "$REPO" merge-tree --write-tree --merge-base="$(rev "$TIP~5")" "$(rev "$TIP")" "$member")
  rebased=$(git -C "$REPO" commit-tree "$tree" -p "$(rev "$TIP")" -m "member work")
  since "rebase the commit onto TIP in the object database" "$s"
  t "move the workspace to the rebased commit" ctl set_base name="$B" base="$rebased" head=true
  echo "[ws] own after: $(own "$B"); status lines: $(count git -C "$W" status --porcelain); HEAD $(git -C "$W" rev-parse --short HEAD) = $(git -C "$REPO" rev-parse --short "$rebased")"
  t "move the workspace to TIP (the landed branch)" ctl set_base name="$B" base="$(rev "$TIP")" head=true
  echo "[ws] own after: $(own "$B"); status lines: $(count git -C "$W" status --porcelain)"
  ;;
writes) # many workspaces written at once, as members building
  s=$(now); pids=()
  for i in $(seq 1 19); do
    ( d=$MNT/ws$i/build-probe; mkdir -p "$d"; for j in $(seq 1 220); do echo "object $i $j" > "$d/o$j.o"; done ) & pids+=($!)
  done; wait "${pids[@]}"
  since "19 workspaces each write 220 new files at once" "$s"
  s=$(now); d=$MNT/ws20/build-probe; mkdir -p "$d"; for j in $(seq 1 220); do echo "object $j" > "$d/o$j.o"; done
  since "one workspace writes 220 new files" "$s"
  t "rm -rf of the 220 files" rm -rf "$MNT/ws20/build-probe"
  s=$(now); pids=(); for i in $(seq 1 19); do ( rm -rf "$MNT/ws$i/build-probe" ) & pids+=($!); done; wait "${pids[@]}"
  since "rm -rf of them in the 19 workspaces at once" "$s"
  f=$(git -C "$MNT/ws21" ls-files 'src/*.cpp' | head -200)
  s=$(now); for p in $f; do echo "// touched" >> "$MNT/ws21/$p"; done
  since "append to 200 files of the commit (each is copied first)" "$s"
  t "git status after" q git -C "$MNT/ws21" status --porcelain
  echo "[ws] own: ws21 $(own ws21); daemon: $(rss)"
  ;;
crash)
  W=$MNT/ws0; echo "uncommitted" > "$W/src/uncommitted_probe.txt"
  p=$(daemon); kill -9 "$p"; sleep 0.5
  t "mount again after kill -9" up
  echo "[ws] uncommitted work: $(cat "$W/src/uncommitted_probe.txt" 2>&1); status lines: $(count git -C "$W" status --porcelain); daemon: $(rss)"
  t "git status after the restart" q git -C "$W" status --porcelain
  ;;
stat)
  ctl stat; echo "[ws] daemon: $(rss)"
  ;;
cleanup)
  s=$(now)
  for name in $(ctl list | python3 -c 'import json,sys; print(" ".join(x["name"] for x in json.load(sys.stdin)["workspaces"]))'); do q ctl remove name="$name"; done
  since "remove every workspace" "$s"
  t "shutdown" ctl shutdown
  ;;
*) echo "no phase $phase";;
esac
done
