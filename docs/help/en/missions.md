# Missions

Missions pair a durable project plan with native OpenCode conversations. The coordinator plans and delegates; the task tree records dependencies and results. A saved plan, an admitted input and observed execution are different facts.

## Create, then explicitly start {#create}

1. Open **Missions** in the right panel and choose **Create mission**.
2. Fill **What should the mission do?** and check **Title**, prefilled from the first sentence (up to 60 characters).
3. Under **When**, select **Once** or **Every day at**. For daily work, verify the displayed time zone; **Change** allows an IANA zone.
4. Expand **Options** for **Playbook**, **Notes**, **Agents and models**, **Task sessions**, saved briefs and optional followed conversations.
5. Choose **Create**. Select the new entry, then use its separate ▶ action when ready: **Start mission** for one-time work, or **Play schedule {id}** for a daily schedule.

**Create never starts work.** A one-time mission is prepared; a daily schedule is paused. Neither creation nor saving a brief arms a timer. Creation is scoped to the selected project/Location and freezes the requested profiles and task-session policy. Validation is beside the affected field; a refusal that says nothing was sent leaves the draft available for correction.

### Playbooks {#playbooks}

| Playbook | Intended work |
| --- | --- |
| Flexible mission | Coordinator chooses a dependency-aware plan for the objective. |
| Debugging | Diagnosis, implementation, separate standards/specification review and fresh validation; resolution continues the implementer. |
| Exploration | Maps uncertainties and works through bounded decisions with human questions. |
| Product delivery | Coordinates product analysis, architecture, implementation and quality roles. |

The playbook guides coordination; it does not bypass native permissions or guarantee success. Answer Exploration's decision questions through CodeNomad's interruption dock so an explicit UI answer is recorded, rather than asking an agent to impersonate approval.

## Follow the tree and read results {#tracking}

1. Select the mission title. The leading chevron keeps its list open; the title field opens a temporary picker.
2. Choose **Summary** (eye) for the central overview, or select a task node for its exact result, brief and evidence.
3. Follow dependency links and **Reports**; use **Open conversation** for the coordinator when you need its transcript.
4. Under **Needs you**, choose **Answer** to open the requesting actor's conversation and interruption dock.

| Indicator | What it establishes |
| --- | --- |
| Assigned | Input was admitted; model consumption/work/completion is not proven. |
| Active | Native activity was observed. |
| Waiting | Declared dependencies are not yet met. |
| Blocked | A blockage was reported, not necessarily a question for you. |
| Needs you | An open native Form/question or permission needs an answer. |
| Done | A task result was recorded; inspect its evidence and any remaining native work. |

The graph includes completed and retired work. Retiring a task does not itself stop its conversation. **In progress** is the mission's lifecycle state, not proof that its coordinator is currently running. Full prose belongs in the central reader, not the panel's task list; **Technical details** folds identifiers and requested execution information.

### Briefings and update requests {#briefings}

The coordinator is instructed to publish a project briefing after its initial plan, after task settlements, when waiting for a human and before the final report. This is an authored assessment, not a live activity counter or guaranteed periodic heartbeat. A notice identifies when the map has changed since the briefing.

Use **Request an update** below the toolbar for a fresh coordinator assessment, then read **Summary**. **Update requested…** means the request is pending, not answered. **Delivery unconfirmed** does not authorize automatic resending: open the coordinator conversation before making a separate new request. This is an ordinary native input, not a read-only sandbox; the coordinator retains its normal permissions.

## Profiles, delegation and depth {#profiles}

1. Use the Missions gear or **Settings → Missions** to edit **New mission defaults**.
2. Choose global defaults and playbook exceptions, then **Save**. In creation, use **Options → Agents and models** for specific requested profiles.
3. Choose **Task sessions** independently of **Playbook**.
4. For native recursion limits, use **OpenCode depth → Maximum depth → Save Location depth** separately.

| Setting | Scope and effect |
| --- | --- |
| New mission defaults | Configuration-wide defaults for **new** missions only; a playbook exception overrides the general default. |
| Agent / Model / Thinking | Requested coordinator/role selections recorded with creation; a busy actor is not silently switched to satisfy later work. Daily runs reuse their frozen requested profiles. |
| Native subagents | Task sessions use native subagent/all agents under the coordinator. |
| Independent sessions | Declared task sessions use primary/all agents and independent conversations; this does not disable internal native helpers. |
| OpenCode depth | Location/project configuration for **all** conversations there, not just Missions. Empty inherits. Save does not reload OpenCode or change running conversations. |

**Native default** and **Inherit global defaults** are different: the former requests native defaults, the latter uses the configured global profile. Catalog availability is checked; a requested profile is not proof of the profile a conversation currently uses. Native permissions and configured depth still govern internal helper calls in either task mode.

If defaults/depth saving is unconfirmed, retain the draft and **Reload** defaults or **Refresh Location depth** before another change. Do not interpret **Effective depth unknown** as zero or disabled.

## Reuse a saved brief {#saved-briefs}

1. In creation, expand **Options → Start from a brief** and select the saved brief.
2. Review the copied objective, notes, playbook, profiles and delegation before **Create**.
3. Use **Save as brief** to name a reusable draft. A selected one-time mission, including a finished one, also offers **Save as brief**.

Briefs store instructions and requested choices, not task plans, results, conversations, schedule clocks or execution authority. Loading one fills an ordinary creation draft; it does not start or schedule anything. Removing a brief keeps existing missions/conversations. **Settings → Missions → Saved briefs** manages the library; an explicit library reset removes saved briefs, not executions. Schedules themselves have no save-as-brief action.

## Daily time, catch-up and followed conversations {#daily-schedules}

Daily schedules use the saved IANA time zone and civil time, not an elapsed 24-hour interval. Times are shown in the schedule's zone, labelled when different from the viewer's. Each run gets its own coordinator and isolated mission map; the selected schedule shows the current task tree and date/outcome history. Select a past run to read it centrally. History is bounded to 30 results.

| Situation | Scheduling behavior |
| --- | --- |
| Several missed due days | Runs only the latest due day newer than the settled daily marker, not a backlog for every missed day. |
| Spring-forward gap | Advances to the first later valid minute; a gap at day end advances across the boundary. |
| Repeated clock hour | Uses the first occurrence; does not create a second daily run. |
| Wholly skipped civil day | No run exists for that day. |
| Clock moves backward | Does not make an already processed day due again. |
| Existing run still pending | Does not overlap it with a new daily run. |

Creation time also bounds eligible daily work; starting a new schedule is not permission to process dates before it existed. **Run now** starts a separate manual run when offered; it does not replace the daily clock or bypass a pending run. A displayed next time is a projection, not a guarantee of exact-time execution.

**Followed conversations (optional)** adds bounded context from chosen conversations. Only a completed run advances their processed-message cursors; a failed/interrupted run does not silently consume that context. If instructions plus context exceed capacity, shorten instructions or remove followed conversations rather than assuming unlimited history is read.

## Lifetime and service restarts {#lifetime}

| Component | What closing it means |
| --- | --- |
| CodeNomad tab/window | Detaches the view; does not stop native work or the OpenCode service. |
| CodeNomad backend | Does not stop OpenCode. One-time CodeNomad coordination depends on backend presence; do not assume new one-time dispatch/control remains available while it is closed. |
| Running daily schedule | Its clock and passage execution run in the OpenCode plugin/service, including with CodeNomad UI and backend closed. The execution host and OpenCode service must stay running. |
| OpenCode service restart | Loses process-local schedule jobs. A desired-running schedule becomes **Interrupted** until an explicit **Resume**; reopening CodeNomad does not rearm it. |

After a restart, inspect the pending run and choose **Resume** when ready. Resume reconciles the existing run without sending its coordinator input twice; it does not promise continuation of an interrupted native turn. A turn cut off by restart can settle as ended without a report, with **Interrupted by a restart**. Do not use restarting as a way to retry tool side effects.

## Pause, Stop and uncertain outcomes {#controls-recovery}

1. Select the entry and inspect its current state and conversation before acting.
2. Use the pause icon for a resumable hold, or the stop icon and confirmation for a terminal stop. One-time tooltips are **Pause mission** and **Stop mission permanently**; schedule tooltips name the schedule.
3. If the result is unconfirmed, use **Check status** / **Check control status** to read the existing outcome. Do not issue a replacement action to bypass uncertainty.
4. For one-time actions, the header's **Refresh and resend the unconfirmed action** first checks state and resends only that still-unconfirmed exact action from your explicit click.

One-time Pause interrupts the mission's native family and parks coordination; Stop also cancels queued family inputs/deliveries and is terminal. These are bounded operations: **Some sub-agents may still be running.** means the stop is incomplete. Inspect the retained result and use its explicit retry rather than assuming all shell/tool effects were cancelled. Resume tells the coordinator about interrupted descendants; it must decide how to continue the work.

Daily Pause/Stop cancel scheduling and request interruption of registered root actors, including the coordinator and independent specialists, but **do not prove that those conversations or their descendants have stopped**. Inspect the native families. Stop is terminal: a stopped schedule cannot Play, Resume or Run now. **Check passage** reconciles a pending run without sending it again. Transient scheduled-check failures display their last failure and retry automatically; a lost user-control reply does not cause automatic control resending.

For a one-time coordinator that is idle without its report, the primary ▶ action can verify and recover it; tasks have targeted missing-report recovery when eligible. Recovery checks native activity, descendants and waits first; unknown activity refuses admission. It does not replay assignments or replace the plan. Open conversations to resolve outstanding questions, permissions, shells or background work.

If **Create** is unconfirmed, the window retains the submitted request and disables further creation for that project; worktree deletion can remain held. Refresh only reads state. Closing/reopening the editor does not repair it. Before reloading the window, inspect the mission list: reload clears the local lock, **not proof that creation failed**. Do not blindly create a duplicate after a reload or restart.

## Edit, delete and clean up conversations {#cleanup}

Use **Edit selected mission** on an editable one-time mission; on a conflict, close/reopen the editor to load the current revision rather than overwrite it. Daily schedules do not offer edit/delete controls.

1. For a one-time mission you no longer need, choose **Delete selected mission…** and review the confirmation.
2. Optionally select **Also delete specialist conversations created for this mission** before confirming.
3. Check **Conversation cleanup** for removed/kept/pending counts. Retry only the remaining recorded cleanup if offered.

Deleting a mission is not the same as stopping it; use Stop and inspect remaining work first. Coordinators and reused conversations are kept. Shared, moved, child-bearing or unverifiably owned specialists may also be retained. Partial cleanup is not rolled back and is not silently completed in the background. Completed cleanup history remains available in the overview reader.

See [Permissions](permissions.md), [Conversations](conversations.md) and [OpenCode setup](opencode.md) for native work and service controls.
