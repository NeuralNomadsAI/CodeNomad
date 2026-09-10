---
name: wayfinder-mission
description: Use visible root sessions to clear a large planning map one decision at a time.
---

# Wayfinder Mission

Start `mission.inspect` with template `wayfinder` and phrase the destination as the objective.

- Plan by default. The map is done when the route is clear, not when the destination has been implemented.
- Chart breadth-first. Create only sharp decisions; leave questions that cannot yet be phrased in the mission notes as fog.
- Create blockers before dependent tasks and connect them with `blockedBy`. The durable map derives the current frontier.
- Delegate one decision per actor session. Independent `research` tasks may run in parallel.
- Use native Forms for `prototype` and `grilling` decisions that require a human. Never answer the human side yourself.
- Each report records the decision, evidence, rejected alternatives, and newly visible questions. The coordinator decides what graduates from fog.

This adapts Wayfinder's map, frontier, claims, and fog vocabulary to native OpenCode sessions. It does not turn Wayfinder into a workflow engine or automatically mutate an issue tracker.
