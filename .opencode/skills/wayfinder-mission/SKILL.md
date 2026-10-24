---
name: wayfinder-mission
description: Clear a planning map through bounded decisions, with independent frontier work in parallel.
---

# Wayfinder Mission

Start `mission.inspect` with template `wayfinder` and phrase the destination as the objective.

- Plan by default. The map is done once the route is clear, without implementing the destination.
- Chart breadth-first. Create only sharp decisions; leave questions that cannot yet be phrased in the mission notes as fog.
- Cover all explicitly requested workstreams. Before waiting for one result, launch the other independent ready decisions with runtime-supported background or concurrent native calls. Keep real evidence/permission gates and resource/shared-write limits; state why any ready work must be serial. Keep unrelated work moving while one workstream is blocked.
- Prefer fresh native children for independent work. Exact eligible actor reuse selects context only; never manufacture `blockedBy` edges to reuse a session, and never continue an actor still busy.
- Create blockers before dependent tasks and connect them with `blockedBy`. The durable map derives the current frontier.
- Declare sharp decisions without demanding completed prerequisites; execution admits only the unblocked frontier. Run independent ready decisions and `research` in parallel when useful; `blockedBy` records only real prerequisites. Each task records one durable decision and may still use native helpers. Pass the canonical `assignmentPrompt` into each ready task's ordinary native call, preserving its declared execution profile and native continuation checks. Independent roots require an explained location, lifetime, existing-root, or playbook exception.
- Use native Forms for `prototype` and `grilling` decisions that require a human. Never answer the human side yourself.
- Native children return the decision, actual evidence, rejected alternatives, and newly visible questions through ordinary native results. The coordinator records the business readout with `mission.report`, `taskKey`, and no `contract`; do not request duplicate child reports or forward task generations/bindings to helpers. Independent-root actors submit their own assigned reports. The coordinator decides what graduates from fog, then uses revision-checked additive frontier tasks without requiring a replacement link. Existing contracts and recorded proofs stay immutable.
- A native `decision` task completes only when the human answered its native question in the CodeNomad interface: the readout is verified against that Form's confirmed UI mark, and `mission.inspect({ taskKey })` lists the qualifying answers with ready-to-pass artifacts. Never write the human's answer or claim consent from prose; without a qualifying answer, report the decision blocked. Gate details: "Wayfinder human decision mark" in `dev-docs/MISSIONS_RECURRING.md`.

Each native child owns its bounded assignment and may recursively decompose useful independent subtasks. Pass relevant scope, planning/human-decision constraints, safety boundaries and this delegation policy to each helper yourself. Helpers gain no coordinator topology or task-report authority and return to their immediate parent, which integrates actual returned evidence. Respect native permissions and the user's configured runtime depth: do not change configuration, force delegation levels, or turn a denied/depth-limited helper into an undeclared independent root. Finish within scope or return the limitation. Avoid conflicting edits/shared mutable checks; never treat a background launch as completion. Use only tools supported by the attached server; never convert tasks stored without an execution mode or real mission data.

This adapts Wayfinder's map, frontier, claims, and fog vocabulary to native OpenCode sessions. Never turn it into a workflow engine or mutate an issue tracker automatically.
