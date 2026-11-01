# Missions

For a persisted field too wide to read as rows, choose **Read raw JSON pages**. **Previous page** and **Next page** read exact, bounded parts of that field; a changed collection requires **Try again** from its first page.

The picker loads 50 mission summaries at a time; **Load more** continues discovery. Search filters loaded missions only. Only selected or reader-targeted missions load their detail. Cleanup history, actor activity and request marks have their own loaded counts and **Load more** controls. Unread actors and requests remain unknown, even after several separately observed windows. **Read persisted fields** in the overview provides exact paged actor, report, history, receipt and extension metadata. A failed window keeps its last display and **Try again** retries it; a changed collection restarts from its first window. Reading or retrying never starts work. Historical completions are seeded once from the durable project finish counter; newly finished missions remain unseen until shown, including while discovery is incomplete.

Missions pair a durable project plan with native OpenCode conversations. The coordinator plans and delegates; the task tree records dependencies and results. A saved plan, an admitted input and observed execution are different facts.

## Create, then explicitly start {#create}

1. Open **Missions** in the right panel and choose **Create mission**. The form replaces the mission list and the selected mission's tasks until you create or cancel.
2. Fill **What should the mission do?** and check **Title**, prefilled from the first sentence (up to 60 characters).
3. Leave **Scheduling** folded for **Once, immediately** and **Without a condition**, or expand it to choose a frequency, a condition and optional limits. Verify **Saved time zone (IANA)** and the preview before creating scheduled work.
4. Expand **Options** for **Playbook**, **Notes**, **Agents and models**, **Task sessions**, the project's **Subsession nesting depth**, saved briefs and optional followed conversations. With **Compare two models**, the **Model A** and **Model B** selectors appear in the main form.
5. Choose **Create**. Select the paused entry, review it, then use ▶ **Start** when ready. Immediate, unconditional work starts one mission; a delayed, recurring or conditional policy arms native scheduling.

**Create saves a paused Mission.** Work and native calendars are armed only by Play; creating or saving a brief preserves the shared service-supervision preference. Creation belongs to the selected project/Location and records the requested profiles and task-session policy. Validation appears beside the affected field; a refusal that says nothing was sent keeps the draft for correction. A one-time coordinator can also prepare a separate follow-up: it appears as **Prepared** and starts from its own ▶ action.

Saved one-time missions retain their execution controls, task tree, conversations and final reports. Existing daily schedules remain listed with their daily controls and [daily timing rules](#existing-daily-schedules). Select the entry and use the controls available for that object.

### Playbooks {#playbooks}

The **Playbook** selector shows the selected playbook's one-sentence description directly below it. **See details** opens the selected playbook in the central reader: its steps, its roles and, folded at the end, the exact English instructions its agents receive. [Playbooks](playbooks.md) explains each playbook's steps, roles and questions, and what CodeNomad checks.

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

A large plan shows a page of its tasks: the first 50 in dependency order and up to 20 that need attention, such as blockages, failures and the newest results. Each run of tasks not loaded shows as **N tasks not shown**; **Show more** loads the next 50 there. When more tasks need attention than the page holds, **N more tasks need attention** gives the mission's counts by kind, and **Show them** loads those tasks. A dashed stub marks a dependency or a dependent task that is not shown, and a dependency link in a task's reader loads its task first. A task's reader shows its newest results; **N earlier results not shown** offers **Show all**, which loads its whole history. When a task or report cannot be loaded, the reader says so; **Try again** loads it again.

Task pages appear only after the requested page has arrived completely. A failed or changed read keeps the last shown tasks. If the task list changes during a read, use **Refresh**, then **Try again**; retrying starts that page again. A missing part never means a task or request is absent, and retrying a read never starts work. If the Missions plugin cannot provide the page, retry after reconnecting or reloading the plugin.

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

In **Exploration**, decision tasks prepare a brief and the coordinator settles each decision: it decides itself when the evidence is enough and the choice is easy to undo, keeps the question in **Notes** for later, or asks you. With **Native subagents**, the decision task's result says who decided:

| Label | Meaning |
| --- | --- |
| **Coordinator decision** | The coordinator decided without asking you; the result shows its rationale and any reversal guidance it supplied. To change it, write to the coordinator from **Open conversation**. |
| **Your answer** | You answered this question in CodeNomad's interruption dock. |

Only an answer you give in the interruption dock counts as **Your answer**; an agent cannot answer for you. With **Native subagents**, each decision question ends with the tag of the one decision it settles, such as `[decision choose-seam 3fa9c21b]`. When several decisions are asked together, each is a separate question with its own tag; a question naming two decisions settles neither. With **Independent sessions**, the coordinator records each outcome in **Notes** instead, stating whether it or you decided. In **Product delivery**, an objective that already describes the behavior change precisely counts as the approved specification; otherwise the coordinator asks you to approve it, grouping pending approvals.

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

Each scheduled passage starts with its own coordinator and mission map, using its saved instructions and frozen inputs. Followed conversations contribute bounded new user and assistant text; their consumed cursors advance after a successful passage. Previous passages remain in the schedule history. Conversations launched within a passage can read its map. A new one-time mission has a separate map: put results to carry forward in its objective or **Notes**, or ask the coordinator to prepare a follow-up with that context.

### Search earlier conversations {#context-search}

While CodeNomad is running, every agent conversation in the project, mission coordinators and tasks included, has CodeNomad's session search tool (`codenomad.session_search`, used through OpenCode's Code Mode). It searches the stored conversations of the conversation's project folder with the same ranking as **Entire workspace** [search](history.md#full-history-search), and returns short excerpts with each conversation's title and identifier, plus a way to read a whole conversation. Native tool permissions apply. An agent searches when it decides to or when the objective, notes or your message ask it to, for example to find what an earlier mission or task concluded. A scheduled passage that executes while CodeNomad is closed works without this tool.

## Profiles, delegation and depth {#profiles}

Saving a depth preserves enabled native schedules in the project configuration. An explicit project `schedules:false` stays disabled; removing the depth keeps the schedules setting. Conflicting JSON and JSONC files must be resolved before saving native settings.

1. Use the Missions gear or **Settings → Missions** to edit **New mission defaults**.
2. Under **Apply to**, choose **All missions** or one playbook, then set **Task sessions** and, under **Agents and models**, one row per role (coordinator, then the playbook's roles). Each choice is saved immediately; there is no Save button.
3. In a playbook scope, rows show the global values marked **Global**. Changing a field customizes that role starting from them; its revert icon uses the global values again. **Reset** (after confirmation) clears only the agents and models of the shown scope.
4. In creation, use **Options → Agents and models** for specific requested profiles; **Use saved defaults** restores the saved ones.
5. For native recursion limits, edit **Subsession nesting depth → Depth override for the project**, here or under creation **Options**. Pressing Enter or leaving the field saves a changed valid value; **Inherit** saves at once; Escape discards an unsaved value.

| Setting | Scope and effect |
| --- | --- |
| New mission defaults | Configuration-wide defaults for **new** missions only; a playbook exception overrides the general default. |
| Agent / Model / Thinking | Requested coordinator/role selections recorded with creation; a busy actor is not silently switched to satisfy later work. Scheduled passages use their saved requested profiles; edits apply to future passages. |
| Native subagents | Task sessions use native subagent/all agents under the coordinator. |
| Independent sessions | Declared task sessions use primary/all agents and independent conversations; this does not disable internal native helpers. |
| Subsession nesting depth | Project configuration for **all** OpenCode conversations there, not just Missions. Empty inherits: **Inherit** removes the project override and an `experimental` block it leaves empty or holding only the Global **Store images once** value. OpenCode reads the project's `experimental` block as a whole, so other experimental settings kept there still hide the global depth. OpenCode's built-in **General** subagent cannot launch subagents by default, so its conversations never nest: saving any project depth also adds a rule to the same file that lets subagents launch their own subagents up to that depth and takes precedence over General's restrictions from other config files (at a depth of 1, OpenCode's depth limit still stops nesting), and **Inherit** removes it. Under **OpenCode effective depth**, the editor says whether General subagents can nest. If the project defines General in the legacy format with a single `permission` value, or with both `task` and `subagent` already set, only the depth is saved and the editor says so: allow subagents for General in that file yourself. Saving does not reload OpenCode or change running conversations. |

**Native default** and **Global** are different: the former requests OpenCode's own defaults, the latter inherits the global choice; choosing native defaults in a playbook scope remains an explicit exception. Catalog availability is checked; a requested profile is not proof of the profile a conversation currently uses. Native permissions and configured depth still govern internal helper calls in either task mode.

Each **Model** list shows what the conversation's **Model** selector shows, under the same names and grouped by provider: hidden models are left out and, while favorites-only filtering is on, so are the other models (see [Model visibility, favorites and Thinking](providers.md#models)). Models without tool support are left out too. A saved model outside the list stays selected. **Unavailable** marks a saved model the selector cannot offer now: it is missing from the project's current catalog, deprecated, or has no tool support.

A refused or unconfirmed choice is never resent: the stored values are shown again, and **Reload** appears only when they cannot be read. If a depth change is unconfirmed, your value is kept; use **Refresh project depth** before another change. Do not interpret **OpenCode effective depth unknown** as zero or disabled.

## Reuse a saved brief {#saved-briefs}

1. In creation, expand **Options → Start from a brief** and select the saved brief.
2. Review the copied objective, notes, playbook, profiles and delegation before **Create**.
3. Use **Save as brief** to name a reusable draft. A selected one-time mission, including a finished one, also offers **Save as brief**.

Briefs store instructions and requested choices, not task plans, results, conversations, schedule clocks or execution authority. Loading one fills an ordinary creation draft; it does not start or schedule anything. Removing a brief keeps existing missions/conversations. **Settings → Missions → Saved briefs** manages the library; if the library becomes unreadable, **Reset the saved library** (after confirmation) removes saved briefs, not executions. Schedules themselves have no save-as-brief action.

## Scheduling, catch-up and followed conversations {#daily-schedules}

### Native scheduling {#native-scheduling}

The **i** icons beside scheduling labels explain the choices: hover, focus with the keyboard or tap.

Expand **Scheduling** in Create or Edit. **Frequency** offers:

| Choice | Timing |
| --- | --- |
| Once, immediately | One launch at Play, with an optional condition checked as described below. |
| Once, at a date | One saved date and time in the IANA zone; a date already past at Play is refused. |
| Once, after a delay | A positive whole duration in minutes or hours, beginning at Play. |
| At an interval | At least 15 minutes; the first wake is one interval after Play. |
| Every day | One civil time in the saved zone. |
| Selected weekdays | One time on the checked weekdays. |
| Several times a day | Up to eight independent times, such as 09:15 and 17:45; duplicate times share a passage. |
| Day of each month | Day 1–31 at the chosen time; months without that day are skipped. |
| Advanced (cron) | A native cron expression, at most once per minute. |

**Next slots (up to five)** previews the saved zone and assumed Play time. With a condition, **Next checks (up to five)** previews checks; a passage depends on a verified change. An unchanged saved interval keeps its native phase. A paused or unknown phase is shown as unavailable until its native state can be read. Delays and intervals use elapsed time; civil calendars follow the saved zone and OpenCode's daylight-saving rules. The displayed dates are projections subject to service and host availability.

After an outage, native scheduling delivers at most one catch-up passage before returning to future slots. It uses the recorded native due slot, which may precede later missed slots. Multiple daily times share this catch-up and the same non-overlap guard. An unresolved passage is reconciled under its original conversation and message identities before another passage can start. Resuming an explicitly paused recurrence uses its next future slot; a paused one-shot can arrive once, late.

### Conditions and sources {#scheduling-conditions}

Choose one optional **Condition** and its **Source in this project**: **Another schedule succeeds**, **New commits on a local branch**, **A one-time Mission completes successfully**, **New message in a followed conversation**, or **Explicit files change**. For a condition alone, keep **Once, immediately**: native checks run every 15 minutes until its one passage launches. With a calendar, the condition is checked at that calendar's slots. Recurring conditions can launch again after new qualifying changes.

First Play establishes the starting reference. Resume preserves it, including changes observed after a pause. Success sources require a verified successful result and a settled native family. Branch checks use local commits and ancestry without fetching. Conversation checks wait for complete, stable new messages and exclude technical wakes and the passage's own conversations. Files use up to 128 explicit project-relative paths, one per line; recursive patterns and linked paths are refused. A missing, moved, ambiguous or over-capacity source blocks admission with an explanation. Changes between checks require a durable trace in the source to be detected.

Changes observed together are grouped. A passage freezes the observed source evidence; successful settlement consumes that snapshot, leaving later changes for a future check. A failed passage keeps its source checkpoint and requires intervention. **Followed conversations (optional)** under **Options** supplies context separately from choosing a conversation-message condition.

### Ends and counts {#scheduling-limits}

Leave limits blank for ongoing recurrence. **Last allowed slot** and **Last allowed slot after this many hours from first Play (optional)** bound eligible slots; the earliest bound applies. The duration starts at first Play and keeps running through Pause. A slot recorded before the end can arrive late after a long outage. A passage already admitted remains observable through its result.

**Maximum launched passages** is a shared total across all times and **Run now**. A passage counts once when its coordinator's first input is admitted, including a passage that later fails. Checks, unchanged conditions and refused wakes consume no place; uncertain admission holds its place pending reconciliation. One-time policies allow at most one passage. Consumed places survive edits and restarts; unchanged end limits retain their first-Play origin and absolute slot end. Changing the maximum changes the lifetime total; a total at or below the consumed count finishes the schedule. A frequency change can start a new interval phase at Save, as the editor explains.

The selected native schedule shows **Desired state**, **Native calendar**, **Next wake** or **Next check**, **Checks** with **Tracked since**, **Launched passages**, **Successful passages**, its end and **Past runs**. Read a past passage through **Open conversation**. **Schedule finished** describes the schedule's end; inspect the passage outcome separately. Results retain the latest 30 entries; lifetime counts survive that window. **Load more Missions** loads the next saved-object page.

The list shows condition and end details only when configured, and **Checks** only with a condition.

### Existing daily schedules {#existing-daily-schedules}

Existing daily schedules use the saved IANA zone and civil time. Each run has its own coordinator and mission map; select its current task tree or a past date/outcome to read the result centrally. Their retained history holds 30 results. The following daily rules apply to these entries:

| Situation | Scheduling behavior |
| --- | --- |
| Several missed due days | Runs only the latest due day newer than the settled daily marker, not a backlog for every missed day. |
| Spring-forward gap | Advances to the first later valid minute; a gap at day end advances across the boundary. |
| Repeated clock hour | Uses the first occurrence; does not create a second daily run. |
| Wholly skipped civil day | No run exists for that day. |
| Clock moves backward | Does not make an already processed day due again. |
| Existing run still pending | Does not overlap it with a new daily run. |

Creation time also bounds eligible daily work. **Run now**, when offered on an existing daily entry, starts a separate manual run under the pending-run guard and preserves its daily clock. A displayed next time is a projection subject to service and host availability.

**Followed conversations (optional)** adds bounded context from chosen conversations. Only a completed run advances their processed-message cursors; a failed/interrupted run does not silently consume that context. If instructions plus context exceed capacity, shorten instructions or remove followed conversations rather than assuming unlimited history is read.

## Lifetime and service restarts {#lifetime}

The **i** beside **Technical details** explains technical activity and costs. In **Settings → OpenCode**, supervision keeps status and errors visible; its **i** holds routine explanations.

For a native schedule, expand **Technical details** to identify its **Principal carrier** and **Reconciliation carrier**, their native calendars and any **Cleanup awaiting reconciliation**. These technical conversations have no composer action and stay out of ordinary conversation/source pickers. Technical wakes, titles and compaction use the local model without provider HTTP requests; native events/statistics can still include them, while actual passages keep their ordinary model costs. Compaction bounds the processed context with the same conversation/calendar identity. Stored native messages and events can grow until explicit cleanup of a finished schedule; the 30 retained Mission results are separate. The depth control and **Scheduling** show the path under **OpenCode configuration file:** when available; the depth control labels its **Project write target** separately.

| Component | What closing it means |
| --- | --- |
| CodeNomad project tab | Closes the project in CodeNomad; native sessions continue in OpenCode. Reopen the project to find them again. |
| Whole window, app quit or renderer reload | Preserves project connections for restoration; does not stop native work or the OpenCode service. |
| CodeNomad backend | Does not stop OpenCode. A running one-time mission continues: its coordinator, native subagent tasks and mission tools run in OpenCode. Assigning tasks to independent sessions and delivering their reports to the coordinator, missions the coordinator prepares, stopping a retired task's conversations, recovery and Mission Control wait for the backend, as does continuing a one-time mission after an OpenCode service restart. |
| Armed native schedule | Persisted OpenCode calendars wake their project and run passages with CodeNomad UI and backend closed, while the execution host and service are available. |
| OpenCode service restart — healthy native schedule | A healthy schedule whose desired state is running resumes its calendar automatically. Pending work is reconciled under its original identities before new admission. |
| Existing daily schedule | Its plugin clock runs with CodeNomad closed while the service lives. A service restart leaves it **Interrupted**; explicit **Resume** reconciles its pending run and rearms its daily clock. |

For native schedules, explicit Pause, Stop, failed work and uncertain outcomes keep their admission barriers after restart. Inspect the retained passage and original request; use **Check passage** or **Refresh saved request** where offered, then **Resume** only when the state permits it. A native continuation is observed under its existing identity. Proven failure or an end without a report requires human recovery; incomplete proof keeps the passage uncertain. Never use a restart to retry engaged tool effects.

[Keep OpenCode running](opencode.md#service-supervision) separately supervises the shared service on its execution host. First Mission Play enables it unless you saved OFF; creating a paused Mission preserves that choice. Turning it off leaves OpenCode running without automatic relaunch. Windows, macOS and WSL use the login boundary; native Linux uses user lingering subject to permissions. Sleep, hibernation, WSL idle lifetime and external-host control limit availability; inspect the supervision status independently of the schedule.

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

Native schedule **Pause** closes future admission and requests interruption of an admitted passage; **Resume** reconciles existing work before rearming. **Stop…** is terminal. **Run now** uses the same pending guard and launched-passage quota while preserving the calendar. **Check passage** reconciles the original passage. Keep an unconfirmed action and use **Refresh saved request**; passive refresh and reconnect preserve that request. Engaged tool effects may continue after interruption.

Existing daily entries keep their daily Pause/Stop/Resume/Run now/Check passage controls. Pause/Stop cancel their clock and request interruption of registered roots, including independent specialists. Inspect their native families and any partial interruption result. Transient daily-check failures retry with their displayed warning; a lost user-control reply stays attached to its original request. A stopped entry remains terminal.

For a one-time coordinator that is idle without its report, the primary ▶ action can verify and recover it; tasks have targeted missing-report recovery when eligible. Recovery checks native activity, descendants and waits first; unknown activity refuses admission. It does not replay assignments or replace the plan. Open conversations to resolve outstanding questions, permissions, shells or background work.

If **Create** is unconfirmed, the window retains the submitted request and disables further creation for that project; worktree deletion can remain held. Refresh only reads state. Closing/reopening the editor does not repair it. Before reloading the window, inspect the mission list: reload clears the local lock, **not proof that creation failed**. Do not blindly create a duplicate after a reload or restart.

## Edit, delete and clean up conversations {#cleanup}

If the objective or notes change while the form is still loading, it says the mission changed since you opened it instead of filling them; choose **Reopen** to edit the current version.

Between passages, a native schedule that is paused or running can edit its title, instructions, notes, requested profiles, task-session mode, sources, calendar and limits when no passage or unresolved control holds the object. A paused schedule stays paused; an armed schedule reconciles its calendar before continuing. Saving preserves past results, consumed sources, launched count and first-Play origin; unchanged end limits retain their absolute slot end.

During an admitted passage, only instructions and notes follow the active text-edit contract: changes are recorded in its history and saved for future passages. Existing tasks, briefs, profiles and execution identities keep their admitted values. Structural fields stay locked until the passage settles, including after Pause. A playbook stays locked once any task has been created, including completed or retired tasks. Uncertain admission/control or incomplete integrity evidence keeps structural editing read-only. Create and Edit share calendar validation; the preview applies the edited last allowed slot to the saved next wake, including a late wake.

The local-branch source includes branches without a worktree, using local refs only. The picker supports up to 200 local branches; a larger inventory shows the source as unavailable. **Start** and **Resume** ask for consent with the exact configuration paths when activation is available. **Run now** stays disabled with an explanation while native scheduling is inactive; enable `experimental.schedules` in OpenCode configuration, then refresh. A lost activation reply keeps the original request for receipt refresh.

Before first Play, you can return to an immediate, unconditional launch while keeping followed conversations under **Options**. Play reads and freezes their complete, stable message prefix (up to 32 messages per source, within the 16,384-character launch envelope). Missing, moved or over-capacity sources block the launch with an explanation. A retry keeps the original frozen context and launch identity.

When a receipt read confirms partial preparation, **Try again** appears. Clicking it checks that same receipt again and resumes only the original saved change, keeping the mission paused.

Before the first launch of a newly prepared mission, you can edit its title, instructions, notes, playbook, requested agents/models/thinking, task-session mode and **Scheduling**. You can switch between immediate, delayed, recurring and conditional launches, keeping the same Mission. Saving keeps it paused and prepares a fresh, empty coordinator; the initial conversation is kept. Only Play starts work or arms a schedule. After launch, instructions and notes follow the active mission's editing rules. If saving is unconfirmed, **Refresh saved request** reads the original outcome; keep that request while a partial preparation blocks Play, text edits and deletion.

Use **Edit selected mission** on an editable one-time mission or native schedule. Read the explanations beside locked fields. On a revision conflict, choose **Reload current configuration**, then open **Previous draft for comparison** to review the retained draft before saving again. Existing daily schedules keep their own toolbar controls.

For a native schedule, **Delete selected mission…** disables future passages before removing the entry. Conversations and results are kept; cleanup awaiting reconciliation remains visible in **Technical details**. Preserve an unconfirmed deletion and refresh its original request.

1. For a one-time mission you no longer need, choose **Delete selected mission…** and review the confirmation.
2. Optionally select **Also delete specialist conversations created for this mission** before confirming.
3. Check **Conversation cleanup** for removed/kept/pending counts. Retry only the remaining recorded cleanup if offered.

Deleting a mission is not the same as stopping it; use Stop and inspect remaining work first. Coordinators and reused conversations are kept. Shared, moved, child-bearing or unverifiably owned specialists may also be retained. Partial cleanup is not rolled back and is not silently completed in the background. The mission card can disappear while deletion confirmation is still pending, even when conversation cleanup shows 0 pending. Keep using the original **Try again** action until deletion is confirmed; it retains the same deletion request and options. The overview reader keeps the 20 most recent completed cleanups. Deleting missions frees their project storage: older deleted missions are cleared automatically.

See [Permissions](permissions.md), [Conversations](conversations.md) and [OpenCode setup](opencode.md) for native work and service controls.
