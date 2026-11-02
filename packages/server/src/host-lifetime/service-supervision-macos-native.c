#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

/* Built with the app, never compiled on the user's machine. No service lifecycle
 * or arbitrary execution: precise native process identity and a pipe-owned lock. */
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  if (strcmp(argv[1], "identity") == 0) {
    char *end;
    errno = 0;
    long value = strtol(argv[2], &end, 10);
    if (errno || *end || value <= 0 || value > 2147483647) return 2;
    pid_t pid = (pid_t)value;
    struct proc_bsdinfo info;
    int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (size == sizeof(info) && info.pbi_start_tvsec) {
      printf("{\"state\":\"live\",\"startIdentity\":\"darwin:%llu:%llu\"}\n",
        (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
    } else if (kill(pid, 0) == -1 && errno == ESRCH) {
      puts("{\"state\":\"dead\"}");
    } else {
      puts("{\"state\":\"unknown\"}");
    }
    return 0;
  }
  if (strcmp(argv[1], "lock") == 0 && strcmp(argv[2], "3") == 0) {
    struct stat st;
    if (fstat(3, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid()
      || st.st_nlink != 1 || (st.st_mode & 077) || flock(3, LOCK_EX | LOCK_NB)) return 3;
    if (write(STDOUT_FILENO, "ready", 5) != 5) return 3;
    char buf[64];
    ssize_t n;
    do { n = read(STDIN_FILENO, buf, sizeof(buf)); } while (n > 0 || (n < 0 && errno == EINTR));
    return n == 0 ? 0 : 3;
  }
  return 2;
}
