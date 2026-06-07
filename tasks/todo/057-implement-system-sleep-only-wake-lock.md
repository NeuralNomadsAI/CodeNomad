---
title: Implement System-Sleep-Only Wake Lock
complexity: complex
track: implementation
slice: logic
status: active
assigned_to: workflow_runner
scr: SCR-2026-04-21-001
---

# Goal

Implement the approved wake-lock behavior change so qualifying active work prevents idle system sleep where supported, allows screen lock/display sleep, and degrades to no wake lock on unsupported platforms.

# Scope

- Update wake-lock decision logic in UI so only qualifying active work engages wake lock.
- Update Electron to use system-sleep-only behavior instead of display wake.
- Update Tauri to request system-idle-sleep prevention without display wake.
- Remove the web screen wake-lock fallback for this feature path.
- Add/adjust tests and documentation impacted by the behavior change.

# Inputs

- `docs/scrs/SCR-2026-04-21-001-wake-lock-system-sleep-only.md`
- `tasks/todo/055-wake-lock-investigation.md`
- `tasks/todo/056-wake-lock-behavior-change.md`
- `tasks/discussions/DISCUSSION-001-wake-lock-behavior-change-for-macos-sleep-vs-screen-lock.md`

# Acceptance Criteria

- AC-1: Wake lock engages only for qualifying active work and does not engage for idle, paused, completed, cancelled, or waiting-for-user-input states.
- AC-2: Electron uses a system-sleep-only mode that allows screen lock/display sleep while active work is running.
- AC-3: Tauri requests the closest supported system-idle-sleep prevention mode without requesting display wake.
- AC-4: Web does not use screen/display wake lock as a fallback for this feature path and instead degrades to no wake lock.
- AC-5: Wake lock is released promptly when qualifying active work ends or the app cleans up.
- AC-6: Required verification demonstrates the new desktop behavior and confirms fallback handling/documentation for unsupported web behavior.

# Implementation Guidance

- Align the UI definition of qualifying active work with the SCR. In particular, do not treat waiting-for-input / permission-question states as wake-lock-worthy unless technical review finds a repository truth conflict that must be escalated.
- Electron target behavior from Tech Lead review: `powerSaveBlocker.start("prevent-app-suspension")`.
- Tauri target behavior from Tech Lead review: use `keepawake` configuration `display: false, idle: true, sleep: false`.
- Web fallback from BA/Tech Lead review: no wake lock for this feature path; do not use `navigator.wakeLock.request("screen")` as a substitute.
- Update product-facing and/or code-adjacent docs as needed to record the supported-platform limitation and resulting behavior.
- Collect clear verification evidence mapped back to AC-1 through AC-6.

# Specialist Expectations

- Workflow Runner should orchestrate implementation plus verification using the appropriate specialists.
- Introduce specialist roles in verification feedback.
- Do not create a final git commit unless PMA explicitly instructs you to do so.

# Notes

- Existing unrelated untracked files in the repository are out of scope unless they block verification.

# Post Implementation Task Updates

## Workflow Runner: Post Implementation Expectations

- UI wake-lock eligibility now follows the SCR definition of qualifying active work and excludes sessions waiting on permission or question input.
- Electron now requests `prevent-app-suspension`, Tauri now requests `display: false, idle: true, sleep: false`, and web no longer falls back to screen wake lock for this feature path.
- Verification covers UI eligibility logic, workspace typechecks/build checks, and the documented unsupported web fallback behavior.
