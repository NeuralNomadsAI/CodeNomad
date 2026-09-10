---
name: pocock-fix-bug-mission
description: Fix a difficult bug with the dynamic Pocock mission playbook and independent visible reviewers.
---

# Pocock Bug Mission

Start `mission.inspect` with template `pocock-fix-bug` and the exact bug report as the objective. Follow the returned evidence gates rather than blindly dispatching every stage.

- Keep one `diagnostician` session until it reports a minimized red feedback loop and confirmed cause.
- Delegate `implementer` only after diagnosis. Require behavioral red/green evidence and the original loop green.
- Then delegate `review-standards` and `review-spec` to two fresh sessions in parallel.
- Reuse the implementer session as `resolver`, passing both review reports in the task brief.
- Use a fresh `validator` session, read-only, for configured typecheck, lint, test, build, and focused regression checks.
- Supply the structured `artifact` required by each assignment when calling `mission.report`; the plugin rejects completed reports that do not prove their role-specific gate.
- Finish green only when every task has completed. Never stage, commit, push, publish, or mutate issue trackers as part of this mission.

For UI bugs, a visible actor may use `codenomad.inspect` as an optional feedback loop. The Developer Mode target fence still applies; another actor or hidden session must fall back to repository-native checks.
