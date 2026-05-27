---
title: Wake Lock Investigation
complexity: standard
track: investigation
slice: logic
status: active
assigned_to: tech_lead
---

# Goal

Understand and explain how wake lock is held across `packages/ui`, `packages/tauri-app`, and `packages/electron-app`, including which layer initiates the request, which native/platform APIs are used, and how acquire/release lifecycle is coordinated.

# Request Context

The Product Owner asked: "Understand how we hold wake lock in packages/ui packages/tauri-app and packages/electron-app".

# Acceptance Criteria

- AC-1: Identify all wake-lock-related code paths in `packages/ui`, `packages/tauri-app`, and `packages/electron-app`.
- AC-2: Explain which package owns the wake-lock decision and which package executes the platform-specific hold/release behavior.
- AC-3: Describe the acquire and release lifecycle, including triggering events, cleanup behavior, and any fallback or unsupported-platform handling.
- AC-4: Note any discrepancies, risks, or unclear behavior discovered during the investigation.

# Instructions For Assigned Agent

1. Read this task file first.
2. Investigate the repository code paths relevant to wake lock in the three packages named above.
3. Produce a concise technical report using the specialist output contract sections:
   - Summary
   - Work Performed
   - Acceptance Criteria Coverage
   - Documentation Impact
   - Open Risks
   - Recommended Next Step
4. Include file paths and function/module names for the relevant wake-lock implementation points.
5. Update this task file with a `# Post Implementation Task Updates` section and `## Tech Lead: Post Implementation Expectations` bullets describing the observable outputs of your investigation.

# Discussion Record

- Created by PMA to answer a direct user investigation request about wake-lock behavior across UI and native app shells.

# Notes

- This is investigation only. Do not implement changes.
- Repository has unrelated untracked items in the working tree (`.nomadworks/`, `.playwright-cli/`, `cloudsecrets`, `tmp/`). Treat them as pre-existing and out of scope unless directly relevant.

# Post Implementation Task Updates

## Tech Lead: Post Implementation Expectations

- Deliver a wake-lock investigation report that traces the call flow from `packages/ui/src/App.tsx` through `packages/ui/src/lib/native/wake-lock.ts` into the Electron preload/main IPC path and the Tauri command path.
- Identify which session states cause the UI to request wake lock and which native APIs actually hold or release the lock on Electron and Tauri.
- Document lifecycle behavior for acquire, release, fallback handling, unsupported-platform behavior, and any cleanup gaps or discrepancies discovered during review.
