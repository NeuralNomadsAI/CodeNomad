# Windows first-install recovery

## Captured 0.20.0 failure

On a Windows 11 x64 machine without Git or a preinstalled OpenCode, the initial
installation invoked the packaged Node 24.20.0 / npm 11.19.0 runtime to install
`@opencode/cli@2.0.16` in the user's standard npm prefix.

The npm log reported failed optional dependencies for both Windows x64 binary
packages, followed by postinstall exit 1 and an EPERM cleanup warning. Cleanup
removed the CLI package but left its generated `opencode.cmd` and `opencode2.cmd`
launchers. The original log does not identify why the binary dependencies failed;
do not attribute this to Git, CPU support, antivirus, or connectivity without
additional evidence.

CodeNomad then reported the executable as missing, but `sharedInstallPrefix`
could no longer verify npm ownership through the removed package manifest and
target executable. `canUpgrade` became false, hiding the install button. A
subsequent successful status refresh also erased the preceding action error.

## Recovery boundaries

`incomplete-installation.ts` recognizes only npm's complete generated Windows
native-executable shim, pointing at the missing canonical OpenCode executable in
the selected user npm prefix. Additional commands, custom wrappers, other prefixes,
and existing unverified executables do not qualify. Detection is read-only.

This narrow residual state remains eligible for an explicit installation retry.
If the orphan shim is already on PATH, discovery probes the missing target
instead of executing the broken wrapper and classifying it as an invalid binary.
The installer retains its existing lock, write preflight, version verification,
launcher verification and explicit PATH registration. It does not automatically
retry npm or restart the service after a failure.

The setup store retains action failures across successful status reads and dialog
reopening. A new explicit action or executable-selection change clears them.

## Validation

- Regression fixture reproduces both pre-PATH and on-PATH orphan-launcher states
  without a package manifest, and checks that install availability survives.
- Explicit repair test exercises updater status, installer admission and final
  installed-version verification; custom-wrapper/foreign-prefix tests protect
  existing installation authority.
- Browser recovery regression checks that refresh and dialog reopening do not
  erase the preceding installation error.
- On the affected machine, an isolated download and `--version` invocation
  succeeded without Git. After explicit user authorization, the packaged npm
  successfully repaired the standard user installation; both the executable
  and `opencode2.cmd` reported 2.0.16. User PATH registration was then completed.

The later success establishes recoverability, not the cause of the earlier
optional-dependency failure. Logs and remote access credentials are not committed.
