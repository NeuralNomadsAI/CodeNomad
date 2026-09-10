---
name: codenomad-missions
description: Coordinate a bounded group of visible OpenCode root sessions through the native CodeNomad mission map.
---

# CodeNomad Missions

Use a mission when independent root sessions should cooperate while remaining visible and directly steerable.

1. Call `mission.inspect` with `start.objective` and one template: `custom`, `pocock-fix-bug`, or `wayfinder`.
2. Read the returned playbook. The starting session is the coordinator and is the only session allowed to call `mission.delegate`.
3. Give every task a stable lowercase `taskKey`. Use `blockedBy` for real dependencies. A blocked task is mapped but not dispatched.
4. Omit `targetSessionID` to create a visible root actor, or provide a same-project root session to reuse it. Prefer `queue`; it is safe when that actor is busy.
5. Actors must call `mission.report`. Reports are delivered back to the coordinator through the native durable inbox and resume it when possible.
6. Inspect after reports, choose the next frontier task, and finish through `mission.report({ final: true, ... })` only when the objective is actually met.

The map is a coordination protocol, not a hidden executor. Do not create speculative tasks, polling loops, nested coordinators, or publication automation.
