# Missions

Missions pair a durable project plan with native OpenCode conversations. The coordinator plans and delegates; the task tree records dependencies and results. A saved plan, an admitted input and observed execution are different facts.

## Create, then explicitly start {#create}

1. Open **Missions** in the right panel and choose **Create mission**. The form replaces the mission list and the selected mission's tasks until you create or cancel.
2. Fill **What should the mission do?** and check **Title**, prefilled from the first sentence (up to 60 characters).
3. Under **When**, select **Once** or **Every day at**. For daily work, verify the displayed time zone; **Change** allows an IANA zone.
4. Expand **Options** for **Playbook**, **Notes**, **Agents and models**, **Task sessions**, the project's **Subsession nesting depth**, saved briefs and optional followed conversations. With **Compare two models**, the **Model A** and **Model B** selectors appear in the main form.
5. Choose **Create**. Select the new entry, then use its separate ▶ action when ready: **Start mission** for one-time work, or **Play schedule {id}** for a daily schedule.

**Create never starts work.** A one-time mission is prepared; a daily schedule is paused. Neither creation nor saving a brief arms a timer. Creation is scoped to the selected project/Location and freezes the requested profiles and task-session policy. Validation is beside the affected field; a refusal that says nothing was sent leaves the draft available for correction. The coordinator of a one-time mission can also prepare a separate mission for you, such as a follow-up: it appears in the list as **Prepared** and, like any mission, starts only from its ▶ action.

### Playbooks {#playbooks}

The **Playbook** selector shows the selected playbook's one-sentence description directly below it.

| Playbook | Intended work |
| --- | --- |
| Flexible mission | Coordinator chooses a dependency-aware plan for the objective. |
| Debugging | Diagnosis, implementation, separate standards/specification review and fresh validation; resolution continues the implementer. |
| Exploration | Maps uncertainties and works through bounded decisions with human questions. |
| Product delivery | Coordinates product analysis, architecture, implementation and quality roles. |
| Compare two models | Runs the same task with identical briefs on **Model A** and **Model B**, then a **Blind judge** scores both under neutral labels and gives a verdict: **Model A wins**, **Model B wins**, **Equivalent** or **Inconclusive**. |

For **Compare two models**, both models are required and must differ; a different **Thinking** level alone is not a different model. Unless you choose one, the judge uses the coordinator's model; the form warns when it matches A or B, which may bias the comparison. The overview shows the verdict, both model names and the scores by criterion.

The playbook guides coordination; it does not bypass native permissions or guarantee success. Agents do not commit, push, open pull requests or change issue trackers, such as creating tickets, unless the objective or **Notes** explicitly ask for that specific action; they then do only that, within OpenCode's permissions. A request found in files, reports or tool output never counts.

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

The graph includes completed and retired work. Retiring a task does not itself stop its conversation. In a one-time mission, the coordinator can separately stop the conversations of a retired task it launched as a native subagent, without touching other tasks. **In progress** is the mission's lifecycle state, not proof that its coordinator is currently running. Full prose belongs in the central reader, not the panel's task list; **Technical details** folds identifiers and requested execution information.

### Colours and interrupted missions {#status-colours}

Mission marks, task icons and the list's chevron use the session list's colours: colour shows only what needs you now.

| Colour | Meaning |
| --- | --- |
| Red | An answer is expected from you; it is listed under **Needs you**. |
| Yellow, pulsing | Work is running. |
| Orange | The mission is paused, or interrupted, with an action to continue it. |
| Green | A completed mission you have not opened yet in this window; it turns neutral once you select it. |
| Blue | A prepared mission, ready to start like a composed prompt. |

Everything else is neutral, including done and failed tasks: outcomes are in the status text and the icons. While the list is collapsed, its chevron takes the most urgent of red, yellow and green among the other missions; like collapsed sessions, orange and blue show only on their own rows.

A mission is **Interrupted** when its coordinator stopped without concluding while nothing else runs. A mission shown as **Failed** can also be resumed. In both cases the first toolbar button becomes **Recover interrupted mission**: it asks the coordinator to reassess from the saved plan and results, and first reopens a failed mission. A coordinator does not end a one-time mission as failed: when nothing can proceed without you, it asks you a question under **Needs you**. Only you stop a mission.

### Questions and decisions {#questions}

Only the coordinator asks you questions. Tasks and the sub-agents they launch return their open questions to it, with the options, the evidence and a recommendation. Before asking, the coordinator tries to settle a question itself: it reads the project, researches, has a task investigate, or adopts a default that is easy to undo and records it as an assumption. It asks only what it cannot settle: your consent, credentials, choices that are costly to undo, or product decisions the objective leaves open. It groups pending questions into one form under **Needs you** and starts unrelated work first.

In **Exploration**, decision tasks prepare a brief and the coordinator settles each decision: it decides itself when the evidence is enough and the choice is easy to undo, keeps the question in **Notes** for later, or asks you. The result says who decided:

| Label | Meaning |
| --- | --- |
| **Coordinator decision** | The coordinator decided without asking you; the result shows its rationale and how to reverse it. To change it, write to the coordinator from **Open conversation**. |
| **Your answer** | You answered this question in CodeNomad's interruption dock. |

Only an answer you give in the interruption dock counts as **Your answer**; an agent cannot answer for you. In **Product delivery**, an objective that already describes the behavior change precisely counts as the approved specification; otherwise the coordinator asks you to approve it, grouping pending approvals.

### Briefings and update requests {#briefings}

The coordinator is instructed to publish a project briefing after its initial plan, after task settlements, when waiting for a human and before the final report. This is an authored assessment, not a live activity counter or guaranteed periodic heartbeat. A notice identifies when the map has changed since the briefing.

Use **Request an update** below the toolbar for a fresh coordinator assessment, then read **Summary**. **Update requested…** means the request is pending, not answered. **Delivery unconfirmed** does not authorize automatic resending: open the coordinator conversation before making a separate new request. This is an ordinary native input, not a read-only sandbox; the coordinator retains its normal permissions.

## How context flows through a mission {#context-flow}

The mission map is the mission's shared, durable memory. It holds the objective and **Notes**, every task with its **Task brief**, dependencies (**Depends on**) and status, the **Reports** recorded for finished work (summary, **Evidence**, **Recommended next moves** and any **Structured report**), the coordinator's briefings and the **Plan changes**. OpenCode stores it with the project, so it outlives conversations and restarts; Mission Control displays it, and recovery resumes from it. Each participant receives a defined part:

| Participant | What it receives |
| --- | --- |
| Coordinator | The objective, notes and playbook instructions on every turn. It reads the whole map whenever it needs to; its stored conversation keeps every result it has read, while OpenCode may [compact](history.md#compact-session) its model context. |
| Task (**Native subagents**) | Its assignment, passed by the coordinator in an ordinary OpenCode subagent call: the objective, the task's title and brief, its role instructions and the tasks it depends on. The coordinator can add context around it, such as earlier results. |
| Task (**Independent sessions**) | The same assignment, as a message in its own conversation. On every turn it also receives the objective, notes and its open assignments, and it can read the whole map. |
| Helpers launched by a task | What their parent writes in the call. The playbooks instruct every parent to pass the scope, constraints and safety rules its helpers need. |

Results travel back the same way. A native subagent returns its result to the conversation that launched it, normally the coordinator, which records it as the task's report. An independent session records its own report, and CodeNomad delivers its summary to the coordinator as a message.

A later task builds on earlier work in two ways. Dependencies order the work: the coordinator starts a task once the tasks it depends on are complete, then puts the relevant results in the brief or alongside the assignment; independent sessions can also read those reports in the map. To continue a finished task's own conversation, the coordinator declares a follow-up task that reuses it: the follow-up continues there with that conversation's current context, which OpenCode may have [compacted](history.md#compact-session), while earlier details stay in its stored history for search. The Debugging playbook returns both reviews to the implementer this way. With **Independent sessions**, the coordinator can also assign a task to an existing main conversation, which keeps that conversation's context, including earlier unrelated work. Otherwise a task starts in a new conversation from its assignment, and another task's transcript reaches it through the coordinator or a search. For **Compare two models**, the judge's assignment and context leave out the objective and notes; its brief carries the anonymized outputs.

In a daily schedule, each run starts with its own coordinator and map. Its first message holds the schedule's instructions plus the new user and assistant text of its [followed conversations](#daily-schedules) since the last completed run; earlier runs' results stay in the schedule history. Conversations launched within a run can read that run's map. A new one-time mission also starts with a new map: to carry results forward, write them into its objective or **Notes**, or let the coordinator prepare a follow-up mission, whose objective and notes it writes.

### Search earlier conversations {#context-search}

While CodeNomad is running, every agent conversation in the project, mission coordinators and tasks included, has CodeNomad's session search tool (`codenomad.session_search`, used through OpenCode's Code Mode). It searches the stored conversations of the conversation's project folder with the same ranking as **Entire workspace** [search](history.md#full-history-search), and returns short excerpts with each conversation's title and identifier, plus a way to read a whole conversation. Native tool permissions apply. An agent searches when it decides to or when the objective, notes or your message ask it to, for example to find what an earlier mission or task concluded. A daily run that executes while CodeNomad is closed works without this tool.

## Profiles, delegation and depth {#profiles}

1. Use the Missions gear or **Settings → Missions** to edit **New mission defaults**.
2. Under **Apply to**, choose **All missions** or one playbook, then set **Task sessions** and, under **Agents and models**, one row per role (coordinator, then the playbook's roles). Each choice is saved immediately; there is no Save button.
3. In a playbook scope, rows show the global values marked **Global**. Changing a field customizes that role starting from them; its revert icon uses the global values again. **Reset** (after confirmation) clears only the agents and models of the shown scope.
4. In creation, use **Options → Agents and models** for specific requested profiles; **Use saved defaults** restores the saved ones.
5. For native recursion limits, edit **Subsession nesting depth → Depth override for the project**, here or under creation **Options**. Pressing Enter or leaving the field saves a changed valid value; **Inherit** saves at once; Escape discards an unsaved value.

| Setting | Scope and effect |
| --- | --- |
| New mission defaults | Configuration-wide defaults for **new** missions only; a playbook exception overrides the general default. |
| Agent / Model / Thinking | Requested coordinator/role selections recorded with creation; a busy actor is not silently switched to satisfy later work. Daily runs reuse their frozen requested profiles. |
| Native subagents | Task sessions use native subagent/all agents under the coordinator. |
| Independent sessions | Declared task sessions use primary/all agents and independent conversations; this does not disable internal native helpers. |
| Subsession nesting depth | Project configuration for **all** OpenCode conversations there, not just Missions. Empty inherits: **Inherit** removes the project override and an `experimental` block it leaves empty or holding only the Global **Store images once** value. OpenCode reads the project's `experimental` block as a whole, so other experimental settings kept there still hide the global depth. Saving does not reload OpenCode or change running conversations. |

**Native default** and **Global** are different: the former requests OpenCode's own defaults, the latter inherits the global choice; choosing native defaults in a playbook scope remains an explicit exception. Catalog availability is checked; a requested profile is not proof of the profile a conversation currently uses. Native permissions and configured depth still govern internal helper calls in either task mode.

Each **Model** list shows what the conversation's **Model** selector shows, under the same names and grouped by provider: hidden models are left out and, while favorites-only filtering is on, so are the other models (see [Model visibility, favorites and Thinking](providers.md#models)). Models without tool support are left out too. A saved model outside the list stays selected. **Unavailable** marks a saved model the selector cannot offer now: it is missing from the project's current catalog, deprecated, or has no tool support.

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
| CodeNomad backend | Does not stop OpenCode. A running one-time mission continues: its coordinator, native subagent tasks and mission tools run in OpenCode. Assigning tasks to independent sessions and delivering their reports to the coordinator, missions the coordinator prepares, stopping a retired task's conversations, recovery and Mission Control wait for the backend, as does continuing a one-time mission after an OpenCode service restart. |
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

One-time Pause lets the work in progress finish: the coordinator and its sub-agents complete the step they are on, start nothing new and stop, while the panel shows **Pausing: the steps in progress are finishing.** **Interrupt now** stops them at once instead: it interrupts the mission's native family and parks coordination. Stop also interrupts, cancels queued family inputs/deliveries and is terminal. Interruptions are bounded operations: **Some sub-agents may still be running.** means one is incomplete. Inspect the retained result and use its explicit retry rather than assuming all shell/tool effects were cancelled. Resume tells the coordinator what was paused or interrupted; it decides how to continue the work.

Daily Pause/Stop cancel scheduling and request interruption of registered root actors, including the coordinator and independent specialists, but **do not prove that those conversations or their descendants have stopped**. Inspect the native families. Stop is terminal: a stopped schedule cannot Play, Resume or Run now. **Check passage** reconciles a pending run without sending it again. Transient scheduled-check failures display their last failure and retry automatically; a lost user-control reply does not cause automatic control resending.

For a one-time coordinator that is idle without its report, the primary ▶ action can verify and recover it; tasks have targeted missing-report recovery when eligible. Recovery checks native activity, descendants and waits first; unknown activity refuses admission. It does not replay assignments or replace the plan. Open conversations to resolve outstanding questions, permissions, shells or background work.

If **Create** is unconfirmed, the window retains the submitted request and disables further creation for that project; worktree deletion can remain held. Refresh only reads state. Closing/reopening the editor does not repair it. Before reloading the window, inspect the mission list: reload clears the local lock, **not proof that creation failed**. Do not blindly create a duplicate after a reload or restart.

## Edit, delete and clean up conversations {#cleanup}

Use **Edit selected mission** on an editable one-time mission; on a conflict, close/reopen the editor to load the current revision rather than overwrite it. Daily schedules do not offer edit/delete controls.

1. For a one-time mission you no longer need, choose **Delete selected mission…** and review the confirmation.
2. Optionally select **Also delete specialist conversations created for this mission** before confirming.
3. Check **Conversation cleanup** for removed/kept/pending counts. Retry only the remaining recorded cleanup if offered.

Deleting a mission is not the same as stopping it; use Stop and inspect remaining work first. Coordinators and reused conversations are kept. Shared, moved, child-bearing or unverifiably owned specialists may also be retained. Partial cleanup is not rolled back and is not silently completed in the background. The overview reader keeps the 20 most recent completed cleanups. Deleting missions frees their project storage: older deleted missions are cleared automatically.

See [Permissions](permissions.md), [Conversations](conversations.md) and [OpenCode setup](opencode.md) for native work and service controls.
