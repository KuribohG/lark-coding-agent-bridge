// Signal cell: run a command whose processes can signal only each other.
//
//   signal-cell --cell ID [--log FILE] -- command [args...]
//   signal-cell --check
//
// Workers of one workflow run as the same user in the same PID namespace, so a
// `pkill -f cargo` in one of them kills every other worker's build. A cell
// confines that without root, namespaces or cgroups, in three processes:
//
//   front        the process the caller started. It passes signals on, exits
//     |          the way the command did, and is gone when the run is over.
//   supervisor   a child subreaper that holds the seccomp listener. It stays
//     |          for as long as anything started in the cell is alive.
//   command      runs under a seccomp filter that hands every syscall which
//                sends a signal to the supervisor to decide.
//
// The supervisor lets a signal through when its target descends from a
// supervisor of the same cell ID, and answers EPERM otherwise. Runs that share
// an ID therefore share a cell: a later turn of a worker can stop what an
// earlier one left running. Being a subreaper is what keeps the test exact: an
// orphaned `setsid nohup` job is adopted by the supervisor instead of init, so
// its ancestry still leads here.
//
// This guards against accidents, not attackers: ptrace, /proc/<pid>/mem and
// other side doors stay open. See docs/signal-isolation.md.
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

// What newer kernels added is spelled out where the headers are older, so the launcher builds there and finds out
// from the kernel it runs on what it can do.
#ifndef SECCOMP_GET_ACTION_AVAIL
#define SECCOMP_GET_ACTION_AVAIL 2
#endif
#ifndef SECCOMP_RET_USER_NOTIF // Linux 5.0
#define SECCOMP_RET_USER_NOTIF 0x7fc00000U
#define SECCOMP_FILTER_FLAG_NEW_LISTENER (1UL << 3)
#define SECCOMP_GET_NOTIF_SIZES 3
struct seccomp_notif_sizes {
  __u16 seccomp_notif;
  __u16 seccomp_notif_resp;
  __u16 seccomp_data;
};
struct seccomp_notif {
  __u64 id;
  __u32 pid;
  __u32 flags;
  struct seccomp_data data;
};
struct seccomp_notif_resp {
  __u64 id;
  __s64 val;
  __s32 error;
  __u32 flags;
};
#define SECCOMP_IOCTL_NOTIF_RECV _IOWR('!', 0, struct seccomp_notif)
#define SECCOMP_IOCTL_NOTIF_SEND _IOWR('!', 1, struct seccomp_notif_resp)
#endif
#ifndef SECCOMP_USER_NOTIF_FLAG_CONTINUE // Linux 5.5
#define SECCOMP_USER_NOTIF_FLAG_CONTINUE (1UL << 0)
#endif
#ifndef SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV // Linux 5.19
#define SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV (1UL << 5)
#endif
#ifndef __NR_pidfd_send_signal
#define __NR_pidfd_send_signal 424
#endif
#ifndef __NR_pidfd_open
#define __NR_pidfd_open 434
#endif

// What a supervisor is called in /proc/<pid>/stat; with `--cell ID` on its
// command line, that is how one supervisor recognizes another of its cell.
#define SUPERVISOR_NAME "cell-supervisor"
// How long a command gets to stop after its front disappeared.
#define STOP_GRACE_SECONDS 5
#define LOG_LINE_LIMIT 200

enum exit_code { EXIT_USAGE = 2, EXIT_NESTED = 3, EXIT_UNSUPPORTED = 4, EXIT_NO_SUPERVISOR = 125 };

enum signal_call { CALL_KILL, CALL_TKILL, CALL_TGKILL, CALL_SIGQUEUE, CALL_TGSIGQUEUE, CALL_PIDFD };

struct filtered_call {
  uint32_t arch;
  uint32_t nr;
  enum signal_call call;
  const char *name;
};

#define SIGNAL_CALLS(arch, kill, tkill, tgkill, sigqueue, tgsigqueue, pidfd) \
  { arch, kill, CALL_KILL, "kill" }, { arch, tkill, CALL_TKILL, "tkill" }, { arch, tgkill, CALL_TGKILL, "tgkill" }, \
  { arch, sigqueue, CALL_SIGQUEUE, "rt_sigqueueinfo" }, { arch, tgsigqueue, CALL_TGSIGQUEUE, "rt_tgsigqueueinfo" }, \
  { arch, pidfd, CALL_PIDFD, "pidfd_send_signal" }

// Every way a process of this machine can ask the kernel to send a signal.
// Entries of one architecture are adjacent; the filter is generated from them.
static const struct filtered_call FILTERED[] = {
#if defined(__x86_64__)
  SIGNAL_CALLS(AUDIT_ARCH_X86_64, __NR_kill, __NR_tkill, __NR_tgkill, __NR_rt_sigqueueinfo, __NR_rt_tgsigqueueinfo,
               __NR_pidfd_send_signal),
  // The x32 ABI shares the architecture and marks its numbers with bit 30.
  SIGNAL_CALLS(AUDIT_ARCH_X86_64, 0x40000000 | 62, 0x40000000 | 200, 0x40000000 | 234, 0x40000000 | 524,
               0x40000000 | 536, 0x40000000 | 424),
  // 32-bit programs, and `int $0x80` from 64-bit ones.
  SIGNAL_CALLS(AUDIT_ARCH_I386, 37, 238, 270, 178, 335, 424),
#elif defined(__aarch64__)
  SIGNAL_CALLS(AUDIT_ARCH_AARCH64, __NR_kill, __NR_tkill, __NR_tgkill, __NR_rt_sigqueueinfo, __NR_rt_tgsigqueueinfo,
               __NR_pidfd_send_signal),
#else
#error "signal-cell supports x86_64 and aarch64"
#endif
};
#define FILTERED_COUNT (sizeof FILTERED / sizeof FILTERED[0])

struct message {
  char kind;
  int value;
};

static const char *cell_id;
static pid_t supervisor_pid;
static int log_fd = -1;
static int log_lines;

static ssize_t read_text(const char *path, char *text, size_t size) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t length = 0;
  while (length < size - 1) {
    ssize_t count = read(fd, text + length, size - 1 - length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) break;
    length += (size_t)count;
  }
  close(fd);
  text[length] = 0;
  return (ssize_t)length;
}

struct process {
  pid_t parent;
  pid_t group;
  char name[64];
};

static int read_process(pid_t pid, struct process *out) {
  char path[48], text[512];
  snprintf(path, sizeof path, "/proc/%d/stat", (int)pid);
  if (read_text(path, text, sizeof text) <= 0) return -1;
  // "pid (name) state parent group ...": the name may hold spaces and parentheses of its own.
  char *open_paren = strchr(text, '('), *close_paren = strrchr(text, ')');
  if (!open_paren || !close_paren || close_paren < open_paren) return -1;
  size_t length = (size_t)(close_paren - open_paren - 1);
  if (length >= sizeof out->name) length = sizeof out->name - 1;
  memcpy(out->name, open_paren + 1, length);
  out->name[length] = 0;
  char state;
  int parent, group;
  if (sscanf(close_paren + 1, " %c %d %d", &state, &parent, &group) != 3) return -1;
  out->parent = parent;
  out->group = group;
  return 0;
}

/** Whether the supervisor `pid` was started for this cell. */
static int names_this_cell(pid_t pid) {
  char path[48], text[8192];
  snprintf(path, sizeof path, "/proc/%d/cmdline", (int)pid);
  ssize_t length = read_text(path, text, sizeof text);
  if (length <= 0) return 0;
  const char *end = text + length;
  for (const char *arg = text + strlen(text) + 1; arg < end && strcmp(arg, "--") != 0; arg += strlen(arg) + 1) {
    const char *value = arg + strlen(arg) + 1;
    if (strcmp(arg, "--cell") == 0) return value < end && strcmp(value, cell_id) == 0;
  }
  return 0;
}

/** 1 when `pid` was started in this cell, 0 when it was not, -1 when there is no such process. */
static int in_cell(pid_t pid) {
  for (int attempt = 0; attempt < 3; attempt++) {
    struct process info;
    if (read_process(pid, &info) < 0) return -1;
    int moved = 0;
    for (int depth = 0; depth < 1024; depth++) {
      pid_t parent = info.parent;
      if (parent == supervisor_pid) return 1;
      if (parent <= 1) return 0;
      // A parent that exited between two reads has handed its child on: start over from the target.
      if (read_process(parent, &info) < 0) { moved = 1; break; }
      if (strcmp(info.name, SUPERVISOR_NAME) == 0 && names_this_cell(parent)) return 1;
    }
    if (!moved) return 0;
  }
  return 0;
}

static pid_t member_of_group(pid_t group) {
  DIR *proc = opendir("/proc");
  if (!proc) return -1;
  pid_t found = -1;
  struct dirent *entry;
  while (found < 0 && (entry = readdir(proc)) != NULL) {
    char *end;
    long pid = strtol(entry->d_name, &end, 10);
    struct process info;
    if (*end || pid <= 0 || read_process((pid_t)pid, &info) < 0) continue;
    if (info.group == group) found = (pid_t)pid;
  }
  closedir(proc);
  return found;
}

/**
 * The same answer for a process group. The command leads a session of its own and a process can only join a group of
 * its session, so a group holds processes of the cell or none: one member answers for all of them.
 */
static int group_in_cell(pid_t caller, pid_t group) {
  struct process info;
  if (read_process(caller, &info) < 0) return -1;
  if (group == 0 || group == info.group) return 1;
  if (read_process(group, &info) == 0 && info.group == group) return in_cell(group);
  pid_t member = member_of_group(group);
  return member < 0 ? -1 : in_cell(member);
}

static pid_t pidfd_target(pid_t caller, int fd) {
  char path[64], text[512];
  snprintf(path, sizeof path, "/proc/%d/fdinfo/%d", (int)caller, fd);
  if (read_text(path, text, sizeof text) <= 0) return 0;
  const char *line = strstr(text, "\nPid:");
  return line ? (pid_t)atoi(line + 5) : 0;
}

static void record(const char *format, ...) {
  if (log_fd < 0 || log_lines > LOG_LINE_LIMIT) return;
  char line[1024];
  time_t now = time(NULL);
  struct tm utc;
  gmtime_r(&now, &utc);
  size_t length = strftime(line, sizeof line, "%Y-%m-%dT%H:%M:%SZ", &utc);
  length += (size_t)snprintf(line + length, sizeof line - length, " cell=%s ", cell_id);
  va_list args;
  va_start(args, format);
  if (log_lines++ == LOG_LINE_LIMIT) snprintf(line + length, sizeof line - length, "more were denied and are not listed");
  else vsnprintf(line + length, sizeof line - length, format, args);
  va_end(args);
  length = strlen(line);
  line[length++] = '\n';
  if (write(log_fd, line, length) < 0) { /* the log is best effort */ }
}

static const struct filtered_call *filtered(uint32_t arch, uint32_t nr) {
  for (size_t index = 0; index < FILTERED_COUNT; index++) {
    if (FILTERED[index].arch == arch && FILTERED[index].nr == nr) return &FILTERED[index];
  }
  return NULL;
}

/** Which argument of the call is the signal number. */
static int signal_argument(enum signal_call call) {
  return call == CALL_TGKILL || call == CALL_TGSIGQUEUE ? 2 : 1;
}

/** 0 to let the syscall run, or the errno its caller gets instead. */
static int decide(const struct seccomp_notif *request) {
  const struct filtered_call *entry = filtered(request->data.arch, (uint32_t)request->data.nr);
  if (!entry) return 0;
  pid_t caller = (pid_t)request->pid;
  int first = (int)request->data.args[0];
  pid_t target = first;
  int verdict;
  char path[64];
  switch (entry->call) {
    case CALL_KILL:
    case CALL_SIGQUEUE:
      if (first == INT_MIN) return ESRCH;
      if (first == -1) verdict = 0;
      else if (first > 0) verdict = in_cell(first);
      else verdict = group_in_cell(caller, -first);
      break;
    case CALL_PIDFD:
      target = pidfd_target(caller, first);
      if (target == 0) return EBADF;
      verdict = target < 0 ? -1 : in_cell(target);
      break;
    case CALL_TKILL:
      // A thread signalling its own process (raise, abort, a language runtime) is the common case.
      snprintf(path, sizeof path, "/proc/%d/task/%d", (int)caller, first);
      verdict = first > 0 && access(path, F_OK) == 0 ? 1 : in_cell(first);
      break;
    default:
      snprintf(path, sizeof path, "/proc/%d/task/%d", first, (int)caller);
      verdict = first > 0 && access(path, F_OK) == 0 ? 1 : in_cell(first);
      break;
  }
  if (verdict > 0) return 0;
  if (verdict < 0) return ESRCH;
  struct process from = { .name = "?" }, to = { .name = "?" };
  read_process(caller, &from);
  if (target > 0) read_process(target, &to);
  record("denied pid=%d (%s) %s target=%d (%s) signal=%d", (int)caller, from.name, entry->name, (int)target, to.name,
         (int)request->data.args[signal_argument(entry->call)]);
  return EPERM;
}

static size_t argument_offset(int index) {
  size_t offset = offsetof(struct seccomp_data, args) + (size_t)index * sizeof(uint64_t);
#if __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
  offset += sizeof(uint32_t);
#endif
  return offset;
}

/**
 * Hands the filtered calls to the listener and allows everything else. Signal 0 only asks whether the target exists,
 * and SIGURG is ignored unless a process asks for it (Go preempts its own threads with it many times a second), so
 * neither is worth a round trip.
 */
static int install_filter(void) {
  struct sock_filter program[4 + FILTERED_COUNT * 8];
  size_t length = 0;
  for (size_t start = 0, end; start < FILTERED_COUNT; start = end) {
    uint32_t arch = FILTERED[start].arch;
    for (end = start; end < FILTERED_COUNT && FILTERED[end].arch == arch; end++) {}
    // Each call below takes six instructions; a different architecture skips them all.
    program[length++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
    program[length++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, arch, 0, (uint8_t)((end - start) * 6 + 2));
    program[length++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
    for (size_t index = start; index < end; index++) {
      uint32_t signal_offset = (uint32_t)argument_offset(signal_argument(FILTERED[index].call));
      program[length++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, FILTERED[index].nr, 0, 5);
      program[length++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, signal_offset);
      program[length++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 2, 0);
      program[length++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SIGURG, 1, 0);
      program[length++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF);
      program[length++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
    }
    program[length++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  }
  program[length++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  struct sock_fprog filter = { .len = (unsigned short)length, .filter = program };
  // Where the kernel can do it, a caller whose call the supervisor has taken up waits for the answer through any
  // signal that does not kill it. Otherwise a program that signals its own threads all the time would have the call
  // start over each time.
  int listener = (int)syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER,
                              SECCOMP_FILTER_FLAG_NEW_LISTENER | SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV, &filter);
  if (listener < 0 && errno == EINVAL) {
    listener = (int)syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &filter);
  }
  return listener;
}

/** Whether the kernel hands calls to a listener, and lets the listener have them continue (Linux 5.5). */
static int kernel_supports_cells(void) {
  struct utsname name;
  int major = 0, minor = 0;
  if (uname(&name) < 0 || sscanf(name.release, "%d.%d", &major, &minor) != 2) return 0;
  if (major < 5 || (major == 5 && minor < 5)) return 0;
  uint32_t action = SECCOMP_RET_USER_NOTIF;
  return syscall(__NR_seccomp, SECCOMP_GET_ACTION_AVAIL, 0, &action) == 0;
}

/**
 * Puts this process under the filter. Returns 'L' with the listener in `*listener`, 'N' when a cell already holds
 * this process (a kernel allows one listener, and the outer cell's rules go on applying), or 'U' with `*error` set
 * when the kernel cannot do it.
 */
static char enter_filter(int *listener, int *error) {
  *listener = -1;
  *error = 0;
  if (!kernel_supports_cells()) { *error = ENOSYS; return 'U'; }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) { *error = errno; return 'U'; }
  *listener = install_filter();
  if (*listener >= 0) return 'L';
  if (errno == EBUSY) return 'N';
  *error = errno;
  return 'U';
}

static int send_message(int channel, char kind, int value, int fd) {
  struct message message = { .kind = kind, .value = value };
  char control[CMSG_SPACE(sizeof(int))] = { 0 };
  struct iovec part = { .iov_base = &message, .iov_len = sizeof message };
  struct msghdr header = { .msg_iov = &part, .msg_iovlen = 1 };
  if (fd >= 0) {
    header.msg_control = control;
    header.msg_controllen = sizeof control;
    struct cmsghdr *rights = CMSG_FIRSTHDR(&header);
    rights->cmsg_level = SOL_SOCKET;
    rights->cmsg_type = SCM_RIGHTS;
    rights->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(rights), &fd, sizeof(int));
  }
  return sendmsg(channel, &header, MSG_NOSIGNAL) == (ssize_t)sizeof message ? 0 : -1;
}

static int receive_message(int channel, struct message *message, int *fd) {
  char control[CMSG_SPACE(sizeof(int))];
  struct iovec part = { .iov_base = message, .iov_len = sizeof *message };
  struct msghdr header = { .msg_iov = &part, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof control };
  ssize_t count;
  do count = recvmsg(channel, &header, MSG_CMSG_CLOEXEC); while (count < 0 && errno == EINTR);
  if (count != (ssize_t)sizeof *message) return -1;
  struct cmsghdr *rights = CMSG_FIRSTHDR(&header);
  if (fd && rights && rights->cmsg_level == SOL_SOCKET && rights->cmsg_type == SCM_RIGHTS) {
    memcpy(fd, CMSG_DATA(rights), sizeof(int));
  }
  return 0;
}

static void signal_command(pid_t command, int signal) {
  // The command leads a process group once it has called setsid; until then only the process is there.
  if (kill(-command, signal) < 0) kill(command, signal);
}

/** The command's side: enter the cell, hand the listener over, and become the command. */
static void run_command(int channel, char **command, const sigset_t *signals) {
  setsid();
  int listener, error;
  char kind = enter_filter(&listener, &error);
  struct message go;
  if (send_message(channel, kind, error, listener) < 0 || receive_message(channel, &go, NULL) < 0) _exit(EXIT_NO_SUPERVISOR);
  sigprocmask(SIG_SETMASK, signals, NULL);
  execvp(command[0], command);
  fprintf(stderr, "signal-cell: cannot run %s: %s\n", command[0], strerror(errno));
  _exit(errno == ENOENT ? 127 : 126);
}

/** The run's pipes must close when the command does, and its directory must not stay busy because of this process. */
static void let_go_of_the_run(const int *keep, size_t count) {
  int null = open("/dev/null", O_RDWR | O_CLOEXEC);
  for (int fd = 0; fd <= 2; fd++) {
    if (null >= 0) dup2(null, fd);
    else close(fd);
  }
  DIR *fds = opendir("/proc/self/fd");
  if (fds) {
    struct dirent *entry;
    while ((entry = readdir(fds)) != NULL) {
      int fd = atoi(entry->d_name), kept = fd <= 2 || fd == dirfd(fds);
      for (size_t index = 0; index < count; index++) kept = kept || fd == keep[index];
      if (!kept && entry->d_name[0] != '.') close(fd);
    }
    closedir(fds);
  }
  if (chdir("/") < 0) { /* the directory is gone already */ }
}

static void answer(int listener, struct seccomp_notif *request, struct seccomp_notif_resp *response,
                   const struct seccomp_notif_sizes *sizes) {
  memset(request, 0, sizes->seccomp_notif);
  // The caller may have been killed since poll saw its call.
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, request) < 0) return;
  int error = decide(request);
  memset(response, 0, sizes->seccomp_notif_resp);
  response->id = request->id;
  if (error) response->error = -error;
  else response->flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
  ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, response);
}

/** The supervisor: starts the command, decides its signals, and stays until nothing started in the cell is left. */
static void supervise(int front, char **command, const char *log_path, const sigset_t *signals) {
  supervisor_pid = getpid();
  setsid();
  prctl(PR_SET_NAME, SUPERVISOR_NAME, 0, 0, 0);
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) < 0) {
    fprintf(stderr, "signal-cell: cannot adopt orphans: %s\n", strerror(errno));
    _exit(1);
  }
  // Nothing may stop the supervisor while the cell has processes; SIGCHLD is read from a descriptor instead.
  sigset_t all, exited;
  sigfillset(&all);
  sigprocmask(SIG_SETMASK, &all, NULL);
  sigemptyset(&exited);
  sigaddset(&exited, SIGCHLD);
  int children = signalfd(-1, &exited, SFD_CLOEXEC | SFD_NONBLOCK);
  int handshake[2];
  if (children < 0 || socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, handshake) < 0) {
    fprintf(stderr, "signal-cell: %s\n", strerror(errno));
    _exit(1);
  }
  pid_t command_pid = fork();
  if (command_pid < 0) {
    fprintf(stderr, "signal-cell: cannot fork: %s\n", strerror(errno));
    _exit(1);
  }
  if (command_pid == 0) {
    close(handshake[0]);
    run_command(handshake[1], command, signals);
  }
  close(handshake[1]);
  send_message(front, 'P', (int)command_pid, -1);

  int listener = -1;
  struct message entered = { .kind = 0 };
  if (receive_message(handshake[0], &entered, &listener) == 0) send_message(handshake[0], 'G', 0, -1);
  close(handshake[0]);
  if (log_path) log_fd = open(log_path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
  if (entered.kind == 'U') record("signals are not confined here: %s", strerror(entered.value));
  const int keep[] = { front, children, listener, log_fd };
  let_go_of_the_run(keep, sizeof keep / sizeof keep[0]);

  struct seccomp_notif_sizes sizes = { 0 };
  struct seccomp_notif *request = NULL;
  struct seccomp_notif_resp *response = NULL;
  if (listener >= 0) {
    if (syscall(__NR_seccomp, SECCOMP_GET_NOTIF_SIZES, 0, &sizes) < 0) _exit(1);
    if (sizes.seccomp_notif < sizeof *request) sizes.seccomp_notif = sizeof *request;
    if (sizes.seccomp_notif_resp < sizeof *response) sizes.seccomp_notif_resp = sizeof *response;
    request = malloc(sizes.seccomp_notif);
    response = malloc(sizes.seccomp_notif_resp);
    if (!request || !response) _exit(1);
  }

  int command_alive = 1;
  time_t kill_at = 0;
  for (;;) {
    struct pollfd watched[3] = {
      { .fd = children, .events = POLLIN },
      { .fd = listener, .events = POLLIN },
      { .fd = front, .events = POLLIN },
    };
    int timeout = -1;
    if (kill_at) {
      time_t now = time(NULL);
      timeout = now >= kill_at ? 0 : (int)(kill_at - now) * 1000;
    }
    if (poll(watched, 3, timeout) < 0) {
      if (errno == EINTR) continue;
      _exit(1);
    }

    if (watched[0].revents) {
      struct signalfd_siginfo info;
      while (read(children, &info, sizeof info) > 0) {}
    }
    for (;;) {
      int status;
      pid_t gone = waitpid(-1, &status, WNOHANG);
      if (gone < 0 && errno == ECHILD) _exit(0);
      if (gone <= 0) break;
      if (gone != command_pid) continue;
      command_alive = 0;
      kill_at = 0;
      if (front >= 0) {
        send_message(front, 'X', status, -1);
        close(front);
        front = -1;
      }
    }
    // The front never writes: anything on its socket means it is gone, and the run with it.
    if (front >= 0 && watched[2].revents) {
      close(front);
      front = -1;
      if (command_alive) {
        signal_command(command_pid, SIGTERM);
        kill_at = time(NULL) + STOP_GRACE_SECONDS;
      }
    }
    if (kill_at && command_alive && time(NULL) >= kill_at) {
      signal_command(command_pid, SIGKILL);
      kill_at = 0;
    }
    if (listener >= 0 && (watched[1].revents & POLLIN)) answer(listener, request, response, &sizes);
    else if (listener >= 0 && watched[1].revents) {
      // No process is under the filter any more.
      close(listener);
      listener = -1;
    }
  }
}

/** Ends the way the command did, so the caller sees the exit code or signal it would have seen without a cell. */
static int mirror(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (!WIFSIGNALED(status)) return 1;
  int signal_number = WTERMSIG(status);
  // The command has left its core dump, if any; this process dying of the same signal must not leave another.
  struct rlimit no_core = { 0, 0 };
  setrlimit(RLIMIT_CORE, &no_core);
  prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
  sigset_t one;
  sigemptyset(&one);
  sigaddset(&one, signal_number);
  signal(signal_number, SIG_DFL);
  sigprocmask(SIG_UNBLOCK, &one, NULL);
  raise(signal_number);
  return 128 + signal_number;
}

/** The front: what the caller holds. Signals it receives go to the command, and the command's exit becomes its own. */
static int front(int supervisor, int signals, int parent) {
  pid_t command = 0;
  int waiting_signal = 0;
  for (;;) {
    struct pollfd watched[3] = {
      { .fd = supervisor, .events = POLLIN },
      { .fd = signals, .events = POLLIN },
      { .fd = parent, .events = POLLIN },
    };
    if (poll(watched, 3, -1) < 0) {
      if (errno == EINTR) continue;
      return 1;
    }
    int forward = 0;
    if (watched[1].revents & POLLIN) {
      struct signalfd_siginfo info;
      if (read(signals, &info, sizeof info) == (ssize_t)sizeof info) forward = (int)info.ssi_signo;
    }
    // Whoever started this run is gone, so nobody is left to end it.
    if (parent >= 0 && watched[2].revents) {
      close(parent);
      parent = -1;
      if (!forward) forward = SIGTERM;
    }
    if (forward && command > 0) signal_command(command, forward);
    else if (forward) waiting_signal = forward;
    if (!watched[0].revents) continue;
    struct message message;
    if (receive_message(supervisor, &message, NULL) < 0) {
      if (command > 0) signal_command(command, SIGKILL);
      fprintf(stderr, "signal-cell: the supervisor exited before the command did\n");
      return EXIT_NO_SUPERVISOR;
    }
    if (message.kind == 'X') return mirror(message.value);
    if (message.kind == 'P') {
      command = (pid_t)message.value;
      if (waiting_signal) signal_command(command, waiting_signal);
      waiting_signal = 0;
    }
  }
}

static int check(void) {
  pid_t child = fork();
  if (child < 0) return EXIT_UNSUPPORTED;
  if (child == 0) {
    int listener, error;
    char kind = enter_filter(&listener, &error);
    _exit(kind == 'L' ? 0 : kind == 'N' ? EXIT_NESTED : EXIT_UNSUPPORTED);
  }
  int status = 0;
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
  int code = WIFEXITED(status) ? WEXITSTATUS(status) : EXIT_UNSUPPORTED;
  puts(code == 0 ? "ok" : code == EXIT_NESTED ? "nested" : "unsupported");
  return code;
}

static int usage(void) {
  fputs("usage: signal-cell --cell ID [--log FILE] -- command [args...]\n"
        "       signal-cell --check\n"
        "  --cell ID    runs with the same ID may signal each other's processes\n"
        "  --log FILE   append one line for each signal that was denied\n"
        "  --check      print whether this kernel can confine signals (ok, nested, unsupported)\n",
        stderr);
  return EXIT_USAGE;
}

int main(int argc, char **argv) {
  const char *log_path = NULL;
  int index = 1;
  for (; index < argc && strcmp(argv[index], "--") != 0; index++) {
    if (strcmp(argv[index], "--check") == 0) return check();
    if (strcmp(argv[index], "--cell") == 0 && index + 1 < argc) cell_id = argv[++index];
    else if (strcmp(argv[index], "--log") == 0 && index + 1 < argc) log_path = argv[++index];
    else return usage();
  }
  if (!cell_id || !*cell_id || strlen(cell_id) > 512 || index + 1 >= argc) return usage();
  char **command = &argv[index + 1];

  sigset_t inherited, forwarded;
  sigprocmask(SIG_SETMASK, NULL, &inherited);
  pid_t parent_pid = getppid();
  int parent = (int)syscall(__NR_pidfd_open, parent_pid, 0);
  int control[2];
  if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, control) < 0) {
    fprintf(stderr, "signal-cell: %s\n", strerror(errno));
    return 1;
  }
  sigemptyset(&forwarded);
  const int passed_on[] = { SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2 };
  for (size_t each = 0; each < sizeof passed_on / sizeof passed_on[0]; each++) sigaddset(&forwarded, passed_on[each]);
  sigprocmask(SIG_BLOCK, &forwarded, NULL);
  int signals = signalfd(-1, &forwarded, SFD_CLOEXEC);
  pid_t supervisor = fork();
  if (supervisor < 0 || signals < 0) {
    fprintf(stderr, "signal-cell: %s\n", strerror(errno));
    return 1;
  }
  if (supervisor == 0) {
    close(control[0]);
    close(signals);
    if (parent >= 0) close(parent);
    supervise(control[1], command, log_path, &inherited);
    _exit(1);
  }
  close(control[1]);
  // The parent died before it could be watched: the descriptor names whatever took its PID, if anything.
  if (parent >= 0 && getppid() != parent_pid) {
    close(parent);
    parent = -1;
    kill(getpid(), SIGTERM);
  }
  return front(control[0], signals, parent);
}
