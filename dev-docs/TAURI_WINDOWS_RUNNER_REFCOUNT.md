# Windows Tauri runtime handle corruption

## Captured failure

The installed Windows build `0.20.1-dev-20261017-3394fc7f` crashed repeatedly
on 2026-10-18 at 00:19:50, 00:36:49 and 00:52:27 local time. Windows reported
`STATUS_HEAP_CORRUPTION` (`0xc0000374`) in `ntdll!RtlFreeHeap`.

The first two minidumps have the same application call chain. The leading
application offsets are `+0xbb9f28`, `+0x1043`, `+0x1165`, `+0x2e87b`,
`+0x2ec26`, `+0x611cf8`, followed by the native event callback and Win32
subclass/message dispatch. Disassembly shows the failing release reached via
a non-atomic reference-count decrement (`dec`, without `lock`). The installed
release's matching PDB was not published; these offsets are evidence, not
claimed symbol names.

The original dumps remain in the machine's Windows CrashDumps directory and
must not be committed or uploaded: they can contain application memory.

The installed build pins Virtua 0.51.0. The later Virtua 0.53.5 change (#991)
is absent from it. The native reproducer below does not load any JavaScript.

## Cause and bounded correction

`tauri-runtime-wry` 2.10.1's clonable context contains
`DispatcherMainThreadContext::window_target`. Its unsafe Send/Sync context
permits public runtime handles to move between threads, but cloning/dropping
the Windows target updates Tao's `Rc<EventLoopRunner>` non-atomically.
IPC-related handle traffic can therefore free the runner while the event loop
still owns it. A different ordering can leave a leaked reference instead.

References: tauri-apps/tauri#15408 and #15793. The same two-file counter change
was proposed in tauri-apps/tao#1290, **closed without merging** because Tao's
target is not intended to cross threads. The violation is in the runtime's
unsafe wrapper; CodeNomad's reproducer needs no unsafe Send wrapper of its own.

For the pinned runtime CodeNomad vendors a narrow compatibility correction:
the Windows runner's shared ownership uses `Arc`. Only reference counting
becomes thread-safe; runner state remains main-thread-only, and the window
target's public threading contract is not widened. Other platforms and existing
Windows input/macOS zoom backports retain their behavior.

## Regression

Run on Windows:

```sh
node scripts/test-tauri-runner-refcount.mjs --baseline
node scripts/test-tauri-input-deadlock.mjs --baseline
```

The new fixture creates the real Wry runtime and performs 800,000 public
runtime-handle clones/drops on eight workers, followed by teardown. It opens
no visible window and uses no web page, CodeNomad data, backend or daemon.
Every corrected run must exit successfully. The optional negative control
copies the same crate and lockfile, reverses only the counter correction,
and runs up to fifty isolated processes, stopping at the first native fault.
A surviving negative-control process is reported explicitly, not counted as a
fault. The race is timing-dependent: about half of the GitHub Windows runners
sampled on 2026-10-21 reproduced it within ten processes (1 to 8 faults) and
the others never did, so in CI a series without a fault emits a warning naming
the CPU instead of failing; locally it still fails. The counter-boundary and
vendored-Tao checks guard the fix on every runner, but the corrected runs on a
machine that printed the warning are no timing evidence.

Initial diagnosis: the original build failed in all three stress runs;
the corrected build completed all five runs (four million clones total).
Debugger inspection of a failing native fixture reached `alloc::rc::Rc::drop_slow`
from a worker thread. The input regression is required alongside this test
because the existing Windows backport shares `event_loop.rs`.

The final scripted negative control reproduced nine native crashes out of ten
processes (one survived); all five corrected processes passed. The input suite
also passed keydown, keyup, char, syschar, IME and the instrumented IME-boundary
case, while each corresponding original/reverted negative control reproduced
its expected deadlock. The release application builds with the same vendor fix.

## Local installation

A release binary built from this worktree with the corrected counter was
installed on the affected machine after normal window shutdown. Existing
resources and the updater verification public key were retained. Its embedded
application version is `0.20.1-dev-20261018-1f132dbb-heapfix` (the Windows PE
version resource still reports the package version, `0.20.1`). SHA-256:

`0e8dce026bd3db3d48d77a4a82820e527e1425d8357214be8851e4ab8e15cea3`

The original executable and matching symbols for the corrected build were
archived locally before replacement. This is a local repair, not a published
release; sustained application use is additional validation beyond the bounded
native regression.
