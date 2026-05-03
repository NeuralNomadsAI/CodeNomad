---
id: DISCUSSION-001
title: "Wake lock behavior change for macOS sleep vs screen lock"
status: closed
summarized_by: business_analyst
source: runtime-transcript
---

# Discussion Summary

## Topic
Change wake lock behavior so screen lock/display sleep is allowed while system sleep is still prevented during active work.

## Purpose
Capture a workflow-ready summary of a requested product behavior change affecting desktop apps and web, including current behavior, desired behavior, scope, and unresolved platform feasibility.

## Repository Truth Relevant To This Discussion
- Current desktop wake lock behavior is effectively configured as a display wake lock.
- Electron currently uses `prevent-display-sleep`.
- Tauri currently includes `display: true` in its wake-lock-related configuration.
- This current setup keeps the screen awake and blocks normal screen lock/display sleep on macOS.

## Facts Established
- The reported problem is specific to current wake lock behavior preventing screen lock on macOS.
- The user wants wake lock to allow screen lock while still preventing the device from going to sleep.
- The requested scope was expanded beyond macOS-only behavior.
- The user explicitly requested coverage for all desktop apps and web.
- Browser/web platform limitations may affect how fully the requested behavior can be implemented.

## Requirements Captured
- Wake lock must allow the display to sleep or lock normally.
- Wake lock must prevent only system sleep while work is active.
- On macOS, the screen should be able to turn off and lock while the machine remains awake enough to continue the task.
- The change should be researched and then applied, not just discussed.
- Scope should include all desktop apps and web, subject to technical feasibility.

## Constraints
- The change affects multiple platforms and should not be treated as a macOS-only behavior change.
- Web support may be constrained by browser capabilities and wake lock API limitations.
- Platform-specific implementation details may differ between Electron, Tauri, and web.

## Non-Goals
- Keeping the display continuously awake.
- Preserving the current display-wake behavior on macOS.
- Defining a macOS-only special case unless later justified.

## Decisions Made
- Preferred product direction: allow display sleep/screen lock while preventing only system sleep during active work.
- Scope direction confirmed by the user: all desktop apps and web.
- The discussion should move into tracked workflow work with product and technical input before implementation.

## Assumptions
- “Work is active” refers to periods when the application is performing a task that currently relies on wake lock protection.
- The intended outcome is continued task execution while the screen is locked or asleep, not continuous visual display.
- Some platforms may require best-effort behavior rather than identical implementation mechanics.

## Open Questions
- What exact user-facing definition of “work is active” should trigger wake lock behavior across products?
- What behavior is achievable on web given browser/API support and permission constraints?
- If a platform cannot prevent only system sleep without also affecting display sleep, what fallback behavior is acceptable?
- Should platform-specific differences be exposed to users or documented in product behavior notes?

## Risks Or Concerns
- Web may not support the requested behavior fully or consistently across browsers.
- A platform may not offer a clean “prevent system sleep only” mode, creating inconsistent behavior across products.
- Changing wake lock semantics could affect long-running task reliability if background execution assumptions are wrong.

## Referenced Files Or Areas
- Electron wake lock implementation using `prevent-display-sleep`
- Tauri wake lock / `keepawake` configuration currently using `display: true`
- Cross-platform wake lock behavior for desktop apps
- Web wake lock behavior and browser capability research areas

## Recommended Workflow Next Step
- assigned_to: product_manager
- why: Create a tracked task and SCR-ready handoff for cross-platform research and specification, then route to business analyst and technical architect for requirements and feasibility clarification before implementation.
