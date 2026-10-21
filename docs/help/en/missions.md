# Missions

Missions pair a durable project plan with native OpenCode conversations. The coordinator plans and delegates; the task tree records dependencies and results. A saved plan, an admitted input and observed execution are different facts.

## Create, then explicitly start {#create}

1. Open **Missions** in the right panel and choose **Create mission**.
2. Fill **What should the mission do?** and check **Title**, prefilled from the first sentence (up to 60 characters).
3. Under **When**, select **Once** or **Every day at**. For daily work, verify the displayed time zone; **Change** allows an IANA zone.
4. Expand **Options** for **Playbook**, **Notes**, **Agents and models**, **Task sessions**, saved briefs and optional followed conversations. With **Compare two models**, the **Model A** and **Model B** selectors appear in the main form.
5. Choose **Create**. Select the new entry, then use its separate ▶ action when ready: **Start mission** for one-time work, or **Play schedule {id}** for a daily schedule.

**Create never starts work.** A one-time mission is prepared; a daily schedule is paused. Neither creation nor saving a brief arms a timer. Creation is scoped to the selected project/Location and freezes the requested profiles and task-session policy. Validation is beside the affected field; a refusal that says nothing was sent leaves the draft available for correction. A coordinator can also prepare a separate mission for you, such as a follow-up: it appears in the list as **Prepared** and, like any mission, starts only from its ▶ action.

### Playbooks {#playbooks}

| Playbook | Intended work |
| --- | --- |
| Flexible mission | Coordinator chooses a dependency-aware plan for the objective. |
| Debugging | Diagnosis, implementation, separate standards/specification review and fresh validation; resolution continues the implementer. |
| Exploration | Maps uncertainties and works through bounded decisions with human questions. |
| Product delivery | Coordinates product analysis, architecture, implementation and quality roles. |
| Compare two models | Runs the same task with identical briefs on **Model A** and **Model B**, then a **Blind judge** scores both under neutral labels and gives a verdict: **Model A wins**, **Model B wins**, **Equivalent** or **Inconclusive**. |

For **Compare two models**, both models are required and must differ; a different **Thinking** level alone is not a different model. Unless you choose one, the judge uses the coordinator's model; the form warns when it matches A or B, which may bias the comparison. The overview shows the verdict, both model names and the scores by criterion.

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
| Awaiting your input | An open native Form/question or permission needs an answer; it is listed under **Needs you**. |
| Done | A task result was recorded; inspect its evidence and any remaining native work. |
| Failed / Retired | The task failed, or the coordinator replaced or abandoned it. |

The graph includes completed and retired work. Retiring a task does not itself stop its conversation; the coordinator can stop a retired task's own conversations separately, without touching other tasks. **In progress** is the mission's lifecycle state, not proof that its coordinator is currently running. Full prose belongs in the central reader, not the panel's task list; **Technical details** folds identifiers and requested execution information.

### Briefings and update requests {#briefings}

The coordinator is instructed to publish a project briefing after its initial plan, after task settlements, when waiting for a human and before the final report. This is an authored assessment, not a live activity counter or guaranteed periodic heartbeat. A notice identifies when the map has changed since the briefing.

Use **Request an update** below the toolbar for a fresh coordinator assessment, then read **Summary**. **Update requested…** means the request is pending, not answered. **Delivery unconfirmed** does not authorize automatic resending: open the coordinator conversation before making a separate new request. This is an ordinary native input, not a read-only sandbox; the coordinator retains its normal permissions.

## Profiles, delegation and depth {#profiles}

1. Use the Missions gear or **Settings → Missions** to edit **New mission defaults**.
2. Under **Apply to**, choose **All missions** or one playbook, then set **Task sessions** and, under **Agents and models**, one row per role (coordinator, then the playbook's roles). Each choice is saved immediately; there is no Save button.
3. In a playbook scope, rows show the global values marked **Global**. Changing a field customizes that role starting from them; its revert icon uses the global values again. **Reset** (after confirmation) clears only the agents and models of the shown scope.
4. In creation, use **Options → Agents and models** for specific requested profiles; **Use saved defaults** restores the saved ones.
5. For native recursion limits, edit **Subsession nesting depth → Depth override for the project**. Pressing Enter or leaving the field saves a changed valid value; **Inherit** saves at once; Escape discards an unsaved value.

| Setting | Scope and effect |
| --- | --- |
| New mission defaults | Configuration-wide defaults for **new** missions only; a playbook exception overrides the general default. |
| Agent / Model / Thinking | Requested coordinator/role selections recorded with creation; a busy actor is not silently switched to satisfy later work. Daily runs reuse their frozen requested profiles. |
| Native subagents | Task sessions use native subagent/all agents under the coordinator. |
| Independent sessions | Declared task sessions use primary/all agents and independent conversations; this does not disable internal native helpers. |
| Subsession nesting depth | Project configuration for **all** OpenCode conversations there, not just Missions. Empty inherits. Saving does not reload OpenCode or change running conversations. |

**Native default** and **Global** are different: the former requests OpenCode's own defaults, the latter inherits the global choice; choosing native defaults in a playbook scope remains an explicit exception. Catalog availability is checked; a requested profile is not proof of the profile a conversation currently uses. Native permissions and configured depth still govern internal helper calls in either task mode.

A refused or unconfirmed choice is never resent: the stored values are shown again, and **Reload** appears only when they cannot be read. If a depth change is unconfirmed, your value is kept; use **Refresh project depth** before another change. Do not interpret **OpenCode effective depth unknown** as zero or disabled.

## Reuse a saved brief {#saved-briefs}

1. In creation, expand **Options → Start from a brief** and select the saved brief.
2. Review the copied objective, notes, playbook, profiles and delegation before **Create**.
3. Use **Save as brief** to name a reusable draft. A selected one-time mission, including a finished one, also offers **Save as brief**.

Briefs store instructions and requested choices, not task plans, results, conversations, schedule clocks or execution authority. Loading one fills an ordinary creation draft; it does not start or schedule anything. Removing a brief keeps existing missions/conversations. **Settings → Missions → Saved briefs** manages the library; if the library becomes unreadable, **Reset the saved library** (after confirmation) removes saved briefs, not executions. Schedules themselves have no save-as-brief action.

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
| CodeNomad project tab | Closes the project in CodeNomad; native sessions continue in OpenCode. Reopen the project to find them again. |
| Whole window, app quit or renderer reload | Preserves project connections for restoration; does not stop native work or the OpenCode service. |
| CodeNomad backend | Does not stop OpenCode. One-time CodeNomad coordination depends on backend presence; do not assume new one-time dispatch/control remains available while it is closed. |
| Running daily schedule | Its clock and passage execution run in the OpenCode plugin/service, including with CodeNomad UI and backend closed. The execution host and OpenCode service must stay running. |
| OpenCode service restart | Loses process-local schedule jobs. A desired-running schedule becomes **Interrupted** until an explicit **Resume**; reopening CodeNomad does not rearm it. |

After a restart, inspect the pending run and choose **Resume** when ready. Resume reconciles the existing run without sending its coordinator input twice; it does not promise continuation of an interrupted native turn. A turn cut off by restart can settle as ended without a report, with **Interrupted by a restart**. Do not use restarting as a way to retry tool side effects.

Missions work with the desktop apps and with a standalone CodeNomad [server](server.md). When the panel shows **Mission Control is unavailable**, its message names the cause:

| Cause | What to do |
| --- | --- |
| The OpenCode workspace is not ready | Reconnect the project, then refresh. |
| OpenCode has not loaded the Missions plugin | Refresh in a moment; if it persists, use **Reload OpenCode configuration** in **Settings → OpenCode**. |
| OpenCode could not load the Missions plugin | Read its error in the Plugins list, then refresh once it is fixed. |
| The CodeNomad server could not open its local Missions connection (127.0.0.1) | Check the server log; reloading OpenCode does not help. |

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
