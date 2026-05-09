---
title: Wake Lock Behavior Change
complexity: complex
track: spec
slice: logic
status: active
assigned_to: business_analyst
scr: SCR-2026-04-21-001
---

# Goal

Research and define the cross-platform wake-lock behavior change so implementation can safely shift from display wake to system-sleep-only behavior wherever feasible.

# Request Context

The Product Owner requested: allow screen lock/display sleep while preventing device sleep during active work, across desktop apps and web, and asked to research options and apply the change.

# Inputs

- `tasks/discussions/DISCUSSION-001-wake-lock-behavior-change-for-macos-sleep-vs-screen-lock.md`
- `tasks/todo/055-wake-lock-investigation.md`
- `docs/scrs/SCR-2026-04-21-001-wake-lock-system-sleep-only.md`

# Acceptance Criteria

- AC-1: Define product intent for when wake lock should engage, using explicit user-observable terms.
- AC-2: Document platform feasibility/options for Electron, Tauri, and web, including unsupported cases.
- AC-3: Recommend a product-safe fallback policy for any platform that cannot prevent system sleep without also preventing screen lock.
- AC-4: Update the SCR with clarified scope and implementation-ready acceptance criteria.

# Instructions For Assigned Agents

## Business Analyst

1. Read this task file and all listed inputs in full.
2. Clarify the product behavior and fallback expectations.
3. Update the SCR with product-facing scope, terminology, and refined ACs.
4. Return the specialist output contract sections.

## Tech Lead

1. After BA input, assess technical feasibility and implementation options for Electron, Tauri, and web.
2. Identify the safest implementation direction and any platform gaps.
3. Return the specialist output contract sections.

# Discussion Record

- Discussion summary captured in `tasks/discussions/DISCUSSION-001-wake-lock-behavior-change-for-macos-sleep-vs-screen-lock.md`.
- User confirmed scope should include all desktop apps and web.
- User asked to research options and apply the resulting change.

# Notes

- This task starts as spec/discovery. Implementation should not begin until product and technical feasibility are clear enough to proceed safely.

# Reviews

- Business Analyst review completed: clarified that product intent is consistent across platforms but platform execution is best-effort, defined "active work" in user-observable terms, and set the fallback rule to prefer no wake lock over display-wake behavior when system-sleep-only support is unavailable.
- Tech Lead review completed: Electron can switch safely to `powerSaveBlocker.start("prevent-app-suspension")`; Tauri can target `keepawake` with `display: false, idle: true, sleep: false` as the closest cross-platform system-idle-sleep-only mode; web has no viable standards-based system-sleep-only API and must fall back to no wake lock. Scope is implementation-ready with explicit platform limitation notes and verification of long-running background behavior per desktop runtime.

# Post Implementation Task Updates

## Business Analyst: Post Implementation Expectations

- The SCR defines "active work" as only currently running in-app work that should continue without continuous foreground interaction, and excludes idle, paused, completed, cancelled, or waiting-for-input states.
- The SCR states a consistent product rule across platforms: allow screen lock/display sleep, use system-sleep-only protection where available, and release protection promptly when qualifying work ends.
- The SCR defines unsupported-platform fallback behavior, including the explicit rule that web or any other unsupported runtime must not use display/screen wake as a substitute and should instead fall back to no wake lock.
- The SCR leaves final platform feasibility validation to technical review without expanding scope into implementation or new user settings.

## Tech Lead: Post Implementation Expectations

- Electron wake lock behavior changes from `prevent-display-sleep` to `prevent-app-suspension`, so active work keeps the machine awake without intentionally blocking display sleep or screen lock.
- Tauri wake lock requests use the native `keepawake` path with `display: false, idle: true, sleep: false`, aligning behavior to prevent idle system sleep without requesting display wake or explicit-sleep inhibition.
- Web no longer attempts `navigator.wakeLock.request("screen")` for this feature path and instead degrades to no wake lock with a documented limitation because the web platform does not expose a true system-sleep-only primitive.
- Runtime behavior releases protection promptly when qualifying active work ends, pauses, fails, is cancelled, or the app cleans up, and desktop verification confirms long-running work continues while the display can sleep or lock.
