#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Built with the app, never compiled on the user's machine. No service lifecycle
 * or arbitrary execution: precise native process identity only. */
int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "identity") != 0) return 2;
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
