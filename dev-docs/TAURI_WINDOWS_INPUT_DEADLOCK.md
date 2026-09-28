# Windows native input deadlock

## Captured failure (2026-09-24)

The installed Tauri host stopped answering Windows messages after idle time.
Its backend still answered authenticated metadata requests and its WebView2
renderer executed JavaScript in 55 ms. A non-invasive native dump, analyzed
offline with matching symbols, located the main thread in
`parking_lot::RawMutex::lock_slow` inside a reentrant Tao window callback.

The lower callback held `KEY_EVENT_BUILDERS` while `KeyEventBuilder::process_message`
called `PeekMessageW`. Windows synchronously delivered another window message;
the nested callback attempted to acquire the same non-reentrant input mutex.
The native automation focus query was waiting behind the blocked event loop.
This conclusively explains the captured freeze, not every earlier reported hang.
The dump is retained locally and is not committed or uploaded.

## Correction and provenance

Backport [tao#1215](https://github.com/tauri-apps/tao/pull/1215), merge commit
`c704261c519c58cfdd0bc2d58ba24e06a0b71c92`, to the published Tao 0.34.6 crate.
The source hunks apply unchanged. `PeekMessageW` runs before input/layout/IME
state locks, and handlers receive the peeked data instead of pumping messages
under those locks. [tao#1349](https://github.com/tauri-apps/tao/issues/1349)
also describes affected older dependency lines after sleep.

Tauri's current dependency range cannot select the fixed 0.36+ line. The
workspace-level Cargo patch selects the local audited crate for both the app
and the fixture, retaining the existing API and cross-platform sources.
`packages/tauri-app/vendor/README.md` records the archive hash and removal rule.
Electron does not use Tao and requires no dependency correction.

## Native regression

Run on Windows from the repository root:

```powershell
node scripts/test-tauri-input-deadlock.mjs --baseline
```

The standalone Rust fixture creates an invisible real Tao window. A native
subclass queues a cross-thread sent focus message immediately before forwarding
an input callback to Tao. `GetQueueStatus` confirms that message is pending.
Tao's `PeekMessageW` dispatches it synchronously, exercising nested acquisition
of the same input state. Assertions require that reentry actually occurred and
both nested and outer callbacks returned. An eight-second process watchdog
bounds a deadlock. No user profile, application backend or OpenCode is started.

The negative control builds the original crates.io Tao in a temporary workspace.
All five scenarios (keydown, keyup, character, system character, IME text) must
reach the watchdog there and must return successfully with the backport. The
character cases seed the key-to-text state; the IME case sends end-composition
before delivering committed text. Cargo metadata also verifies that Tauri and
the fixture resolve one local Tao implementation. Windows PR CI runs both controls.

Local validation reproduced all five original deadlocks and passed all five
patched cases. This deterministic test covers message reentry, not a manual
sleep/resume or RDP endurance run.

### Independent IME lock boundary

The initial five scenarios alone cannot protect the IME lock: the patched
keyboard pre-peek can consume the sent focus message before the IME callback.
The runner therefore also builds a temporary copy of the actual vendored Tao
with a probe message at the start of the IME callback. The fixture queues focus
only at that probe, after keyboard processing finishes, and returns without
pumping messages. The actual IME peek must complete the nested focus callback.
The checked-in crate and application build contain no probe or test hook.

A mandatory mutation control moves only `more_ime_char_coming` back under the
real `window_state` mutex in that temporary copy, leaving the keyboard fix
intact. The IME-boundary scenario must pass with the upstream ordering and hit
the watchdog with the mutated ordering. Source anchors must match exactly once,
so upstream changes require explicitly revisiting this instrumentation.
