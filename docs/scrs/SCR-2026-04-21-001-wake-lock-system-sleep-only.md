---
id: SCR-2026-04-21-001
title: Wake lock should allow screen lock while preventing system sleep
status: draft
---

# Summary

Refine wake-lock behavior so the product protects long-running active work from device/system sleep without intentionally keeping the display awake. The desired product experience is: users may lock the screen or let the display sleep, and in-platform work should continue whenever the platform can support that behavior.

# Problem

Current wake-lock behavior on desktop is oriented around display wake, which prevents normal screen lock or display sleep behavior on macOS and does not match the requested product outcome. The Product Owner wants wake lock to protect only against system/device sleep during active work, not against display sleep or screen lock. Scope includes Electron, Tauri, and web, with documented best-effort degradation where platform APIs cannot provide a system-sleep-only capability.

# Requested Outcome

- Allow the screen/display to sleep or lock normally while qualifying work is in progress.
- Prevent only system/device sleep during qualifying active work on platforms that support a system-sleep-only hold.
- Keep platform behavior aligned to a single product rule: never intentionally keep the display awake as a fallback for this feature.
- Apply the behavior across Electron, Tauri, and web using best-effort platform support with explicit limitation handling.

# Product Scope

## Active Work Definition

For this change, **active work** means a user-initiated or product-initiated in-app operation that:

- has started execution,
- is represented by the product as still in progress,
- is expected to continue without continuous foreground interaction, and
- would lose reliability or stop early if the device enters normal system sleep.

Active work does **not** include:

- the app merely being open or focused,
- idle viewing or reading states,
- paused, completed, failed, or cancelled work,
- states waiting indefinitely for new user input before further execution, or
- generic background presence without a currently running task.

## Product Behavior Rule

- When active work starts, the product may request a wake lock only if the platform can do so **without intentionally blocking screen lock or display sleep**.
- When active work ends, pauses, fails, is cancelled, or no longer needs protection, the product must release the wake lock promptly.
- The product intent is consistent across platforms, but implementation is **best-effort by platform capability**, not strict-identical by mechanism.

## Fallback Policy

- If a platform can provide **system-sleep-only** protection, the product should use it.
- If a platform can only provide a **display/screen wake** lock that keeps the screen awake, the product must **not** use that mode as a fallback for this feature.
- In unsupported or partially supported environments, the product should fall back to **no wake lock** rather than preserving the old display-wake behavior.
- Unsupported behavior must be treated as a documented platform limitation, not as a product failure.

## Platform Expectations

- **Electron:** In scope to use a system-sleep-only mode if available.
- **Tauri:** In scope to use a system-sleep-only mode if available through the chosen Tauri/native path.
- **Web:** Default expectation is unsupported or partially supported for this exact behavior unless a browser/runtime exposes a true system-sleep-only primitive. A screen wake lock that keeps the display awake is not an acceptable substitute.

## Non-Goals

- Keeping the display continuously awake during long-running work.
- Preserving current display-wake behavior on platforms where that is the only available wake-lock mode.
- Inventing platform-specific user settings to choose between display wake and system-sleep-only behavior as part of this SCR.

# Acceptance Criteria

- AC-1: The specification defines **active work** in user-observable product terms, including the states that do and do not qualify for wake-lock protection.
- AC-2: The specification defines a single cross-platform product rule: qualifying active work should protect against system sleep where possible, while screen lock and display sleep remain allowed.
- AC-3: The specification defines the fallback policy for unsupported platforms: if system-sleep-only protection is unavailable, the product must not substitute display/screen wake behavior and must instead degrade to no wake lock.
- AC-4: Platform expectations are documented for Electron, Tauri, and web, including the explicit expectation that web is best-effort and may remain unsupported for this exact behavior.
- AC-5: The specification defines wake-lock release expectations so protection ends promptly when qualifying active work is no longer running.
- AC-6: Any implementation derived from this SCR must document user-visible limitations for unsupported platforms in the appropriate product-facing documentation if final technical validation confirms those limitations.

# Implementation Notes For Follow-On Technical Assessment

- Electron and Tauri feasibility still requires technical validation of the exact API mode, lifecycle reliability, and background-execution behavior.
- Web feasibility still requires confirmation of browser/runtime support, permission constraints, visibility restrictions, and whether any supported runtime offers a true system-sleep-only primitive.
- If technical validation shows a desktop platform cannot provide system-sleep-only behavior safely, implementation should follow the fallback policy above rather than retaining display-wake behavior.
