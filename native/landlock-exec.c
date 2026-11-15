/*
 * landlock-exec — run a command under a Landlock filesystem allowlist.
 *
 * The bridge spawns every agent run through this launcher so that the agent
 * process, its tools, and every descendant inherit one Landlock domain. Once
 * applied the domain cannot be widened, so a wrong-path delete or a prompt
 * injected into the model cannot touch paths the profile did not allow.
 *
 * Usage:
 *   landlock-exec --ro / --rw /work --rw /tmp [--no-tcp] [--require] \
 *                 [--quiet] -- COMMAND [ARG...]
 *
 * Rules are deny-by-default: every filesystem access right the running kernel
 * supports is handled, and only the paths named by --ro/--rw are granted back.
 * A rule on a directory covers its whole subtree. A path that does not exist
 * is skipped, so callers can list optional cache directories.
 *
 * Exit codes: 125 when --require is set and the sandbox cannot be applied,
 * 126/127 for exec failures, otherwise the command's own status.
 *
 * Landlock constants are defined here rather than taken from <linux/landlock.h>
 * so the launcher builds against older headers and still speaks ABI 4.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#define LL_CREATE_RULESET_VERSION (1U << 0)

/* Filesystem access rights, Linux 5.13+ (ABI 1) through 6.10 (ABI 5). */
#define LL_FS_EXECUTE     (1ULL << 0)
#define LL_FS_WRITE_FILE  (1ULL << 1)
#define LL_FS_READ_FILE   (1ULL << 2)
#define LL_FS_READ_DIR    (1ULL << 3)
#define LL_FS_REMOVE_DIR  (1ULL << 4)
#define LL_FS_REMOVE_FILE (1ULL << 5)
#define LL_FS_MAKE_CHAR   (1ULL << 6)
#define LL_FS_MAKE_DIR    (1ULL << 7)
#define LL_FS_MAKE_REG    (1ULL << 8)
#define LL_FS_MAKE_SOCK   (1ULL << 9)
#define LL_FS_MAKE_FIFO   (1ULL << 10)
#define LL_FS_MAKE_BLOCK  (1ULL << 11)
#define LL_FS_MAKE_SYM    (1ULL << 12)
#define LL_FS_REFER       (1ULL << 13) /* ABI 2 */
#define LL_FS_TRUNCATE    (1ULL << 14) /* ABI 3 */

/* Network access rights, ABI 4. */
#define LL_NET_BIND_TCP    (1ULL << 0)
#define LL_NET_CONNECT_TCP (1ULL << 1)

#define LL_RULE_PATH_BENEATH 1
#define LL_RULE_NET_PORT     2

#define LL_ABI_NET 4
#define LL_ABI_REFER 2
#define LL_ABI_TRUNCATE 3

struct ll_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
};

struct ll_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

enum rule_mode { RULE_RO, RULE_RW };

struct path_rule {
  const char *path;
  enum rule_mode mode;
};

static int quiet;

static void warn(const char *fmt, const char *arg) {
  if (quiet) return;
  fputs("landlock-exec: ", stderr);
  fprintf(stderr, fmt, arg);
  fputc('\n', stderr);
}

static void usage(void) {
  fputs(
    "usage: landlock-exec [options] -- COMMAND [ARG...]\n"
    "\n"
    "  --ro PATH     read+execute access on PATH (repeatable)\n"
    "  --rw PATH     read+write access on PATH (repeatable)\n"
    "  --no-tcp      deny every TCP bind and connect (ABI 4+)\n"
    "  --require     fail instead of running unsandboxed when Landlock is unavailable\n"
    "  --quiet       do not warn when falling back\n"
    "  --print-abi   print the kernel Landlock ABI version and exit\n",
    stderr);
}

/* Access rights a directory rule grants, given the kernel ABI. */
static uint64_t dir_access(enum rule_mode mode, int abi) {
  uint64_t access = LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR;
  if (mode != RULE_RW) return access;
  access |= LL_FS_WRITE_FILE | LL_FS_REMOVE_DIR | LL_FS_REMOVE_FILE |
            LL_FS_MAKE_CHAR | LL_FS_MAKE_DIR | LL_FS_MAKE_REG |
            LL_FS_MAKE_SOCK | LL_FS_MAKE_FIFO | LL_FS_MAKE_BLOCK |
            LL_FS_MAKE_SYM;
  if (abi >= LL_ABI_REFER) access |= LL_FS_REFER;
  if (abi >= LL_ABI_TRUNCATE) access |= LL_FS_TRUNCATE;
  return access;
}

/* A file rule may only carry the rights that apply to non-directories. */
static uint64_t file_access(enum rule_mode mode, int abi) {
  uint64_t access = LL_FS_EXECUTE | LL_FS_READ_FILE;
  if (mode != RULE_RW) return access;
  access |= LL_FS_WRITE_FILE;
  if (abi >= LL_ABI_TRUNCATE) access |= LL_FS_TRUNCATE;
  return access;
}

static uint64_t handled_fs(int abi) {
  uint64_t access = LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE |
                    LL_FS_READ_DIR | LL_FS_REMOVE_DIR | LL_FS_REMOVE_FILE |
                    LL_FS_MAKE_CHAR | LL_FS_MAKE_DIR | LL_FS_MAKE_REG |
                    LL_FS_MAKE_SOCK | LL_FS_MAKE_FIFO | LL_FS_MAKE_BLOCK |
                    LL_FS_MAKE_SYM;
  if (abi >= LL_ABI_REFER) access |= LL_FS_REFER;
  if (abi >= LL_ABI_TRUNCATE) access |= LL_FS_TRUNCATE;
  return access;
}

static int landlock_abi(void) {
  long ret = syscall(__NR_landlock_create_ruleset, NULL, 0,
                     LL_CREATE_RULESET_VERSION);
  return ret < 0 ? 0 : (int)ret;
}

static int add_path_rule(int ruleset_fd, const struct path_rule *rule, int abi) {
  int fd = open(rule->path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT || errno == ENOTDIR) return 0;
    fprintf(stderr, "landlock-exec: cannot open %s: %s\n", rule->path,
            strerror(errno));
    return -1;
  }
  struct stat st;
  if (fstat(fd, &st) < 0) {
    fprintf(stderr, "landlock-exec: cannot stat %s: %s\n", rule->path,
            strerror(errno));
    close(fd);
    return -1;
  }
  struct ll_path_beneath_attr attr;
  attr.parent_fd = fd;
  attr.allowed_access = S_ISDIR(st.st_mode) ? dir_access(rule->mode, abi)
                                            : file_access(rule->mode, abi);
  if (syscall(__NR_landlock_add_rule, ruleset_fd, LL_RULE_PATH_BENEATH, &attr,
              0) < 0) {
    fprintf(stderr, "landlock-exec: add rule for %s: %s\n", rule->path,
            strerror(errno));
    close(fd);
    return -1;
  }
  close(fd);
  return 1;
}

/* Applied lazily so a fallback can still run the command unsandboxed. */
static int apply_sandbox(const struct path_rule *rules, size_t count, int abi,
                         int deny_tcp) {
  struct ll_ruleset_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.handled_access_fs = handled_fs(abi);
  size_t size = sizeof(attr.handled_access_fs);
  if (abi >= LL_ABI_NET && deny_tcp) {
    attr.handled_access_net = LL_NET_BIND_TCP | LL_NET_CONNECT_TCP;
    size = sizeof(attr);
  }
  int ruleset_fd =
      (int)syscall(__NR_landlock_create_ruleset, &attr, size, 0);
  if (ruleset_fd < 0) {
    fprintf(stderr, "landlock-exec: create ruleset: %s\n", strerror(errno));
    return -1;
  }
  for (size_t i = 0; i < count; i++) {
    int added = add_path_rule(ruleset_fd, &rules[i], abi);
    if (added < 0) {
      close(ruleset_fd);
      return -1;
    }
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
    fprintf(stderr, "landlock-exec: no_new_privs: %s\n", strerror(errno));
    close(ruleset_fd);
    return -1;
  }
  if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) < 0) {
    fprintf(stderr, "landlock-exec: restrict self: %s\n", strerror(errno));
    close(ruleset_fd);
    return -1;
  }
  close(ruleset_fd);
  return 0;
}

static void exec_target(char **argv, int index) {
  execvp(argv[index], &argv[index]);
  fprintf(stderr, "landlock-exec: exec %s: %s\n", argv[index], strerror(errno));
  exit(errno == ENOENT ? 127 : 126);
}

int main(int argc, char **argv) {
  struct path_rule *rules = calloc((size_t)argc, sizeof(*rules));
  size_t rule_count = 0;
  int require = 0, deny_tcp = 0, print_abi = 0;
  int command_index = -1;

  if (!rules) {
    fputs("landlock-exec: out of memory\n", stderr);
    return 125;
  }
  for (int i = 1; i < argc; i++) {
    const char *arg = argv[i];
    if (strcmp(arg, "--") == 0) {
      command_index = i + 1;
      break;
    }
    if (strcmp(arg, "--ro") == 0 || strcmp(arg, "--rw") == 0) {
      if (i + 1 >= argc) {
        fprintf(stderr, "landlock-exec: %s needs a path\n", arg);
        return 125;
      }
      rules[rule_count].path = argv[++i];
      rules[rule_count].mode = strcmp(arg, "--rw") == 0 ? RULE_RW : RULE_RO;
      rule_count++;
      continue;
    }
    if (strcmp(arg, "--no-tcp") == 0) {
      deny_tcp = 1;
      continue;
    }
    if (strcmp(arg, "--require") == 0) {
      require = 1;
      continue;
    }
    if (strcmp(arg, "--quiet") == 0) {
      quiet = 1;
      continue;
    }
    if (strcmp(arg, "--print-abi") == 0) {
      print_abi = 1;
      continue;
    }
    if (strcmp(arg, "--help") == 0 || strcmp(arg, "-h") == 0) {
      usage();
      return 0;
    }
    if (arg[0] == '-' && arg[1] != '\0') {
      fprintf(stderr, "landlock-exec: unknown option %s\n", arg);
      usage();
      return 125;
    }
    command_index = i;
    break;
  }
  if (print_abi) {
    printf("%d\n", landlock_abi());
    return 0;
  }
  if (command_index < 0 || command_index >= argc) {
    fputs("landlock-exec: missing command\n", stderr);
    usage();
    return 125;
  }

  int abi = landlock_abi();
  if (abi <= 0) {
    if (require) {
      fputs("landlock-exec: Landlock is not available on this kernel\n", stderr);
      return 125;
    }
    warn("Landlock is not available; running %s unsandboxed", argv[command_index]);
    exec_target(argv, command_index);
  }
  if (deny_tcp && abi < LL_ABI_NET) {
    if (require) {
      fputs("landlock-exec: TCP rules need Landlock ABI 4\n", stderr);
      return 125;
    }
    warn("TCP rules need Landlock ABI 4; running %s with TCP allowed",
         argv[command_index]);
    deny_tcp = 0;
  }
  if (apply_sandbox(rules, rule_count, abi, deny_tcp) < 0) {
    if (require) {
      fputs("landlock-exec: sandbox setup failed and --require is set\n", stderr);
      return 125;
    }
    warn("sandbox setup failed; running %s unsandboxed", argv[command_index]);
  }
  free(rules);
  exec_target(argv, command_index);
  return 127;
}
