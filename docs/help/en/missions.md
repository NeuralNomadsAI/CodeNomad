# Missions

A Mission keeps an objective, a coordinator conversation, tasks and their results together. Open **Missions** in the right panel.

If Missions is unavailable, **OpenCode settings** opens runtime recovery for a missing or failed plugin. **Server diagnostics** opens the diagnostic report in Settings → Info when the server's local Missions bridge is unavailable.

## Show or hide Missions {#activation}

In **Customize right panel**, check **Missions** to show the tab or uncheck it and confirm to hide it. This also writes `codenomad.missions` or `-codenomad.missions` in the connected OpenCode server’s Global configuration. Project rules can override Global. Turning it off deletes and pauses nothing, but scheduled runs can be missed. If the write fails, the tab keeps your visibility choice. **Reset** only resets the layout. **Status → Plugins** skips the warning for the exact Global disable; other disables still offer **Re-enable**.

## Create a Mission {#create}

Remote connections use the same form and controls. Prefer HTTPS to protect network traffic.

Choose **Create mission**. The form replaces the tree until you create or cancel. A confirmed creation selects the Mission; a refused creation leaves the form editable.

Ask an agent in any project conversation, including a subagent or scheduled run, to prepare a separate one-time or scheduled Mission. Its conversation stays unchanged; a new coordinator is the default. Keep the owning CodeNomad backend available. Explicitly requesting **Start automatically** authorizes that new Mission's first start; recovery reads the original result. Agents can also list, inspect, start, pause, stop, resume, **Run now**, check, edit and delete any schedule in this project, including one you created in the editor. The same revision and admission checks apply; explicit scheduling OFF is preserved. An unconfirmed action keeps its original request for read-only status recovery.

### Configuration {#saved-briefs}

Agents can read every Mission in the project, including yours, from any owned conversation. Read-only project views cover tasks, results, cleanup, scheduled passages and source choices; browsing never starts or retries work.

Agents can also diagnose scheduling, prepare its settings while preserving explicit OFF, and resume a confirmed partial edit with its original request.

For one-time Missions, agents can start, resume, pause gracefully, interrupt immediately, stop, edit, delete, resume coordination after failure, request a missing report or ask for an update. This includes Missions you created, with the same admission and revision checks as the panel. Deletion follows your managed-session deletion preference unless explicitly overridden. Unconfirmed controls and cleanup keep their original identity; agents read the saved status before explicitly continuing a confirmed partial action.

**Configuration** optionally loads a saved objective, notes, playbook, agents/models and task-session choices. Its name supplies the editable title. Check the filled fields before creating.

Agents can read, save, replace or rename, remove and repair saved configurations, including saving an existing Mission's instructions. They can also change global or playbook-specific profile and task-session defaults, restore inheritance, reset invalid preferences, and change the task-conversation deletion preference. The library and these preferences apply across the CodeNomad profile's projects. Project subagent depth supports 1–10 or **Inherit**, including repair of an empty configuration block. Each change checks the last-read value and preserves intervening human edits.

**Save configuration**, in the footer beside Cancel and Create, names and saves a reusable configuration. It does not create or start a Mission. Scheduling and **Start automatically** are separate choices. The Missions gear opens Preferences, including the saved-configuration library; removing a configuration keeps existing missions and conversations.

To replace a saved configuration, use its name and choose **Replace**. If several share that name, load the one you want to replace first. A new name saves a separate copy while the library has room.

### Objective, Title and Notes {#mission-instructions}

- **Objective**: the result you want and how to check it.
- **Title**: the name in the tree. For a blank Mission it follows the objective's first sentence, up to 60 characters; you can edit it.
- **Notes**: optional context, constraints or additional instructions for the agents. Keep information needed to do the work here, rather than UI settings.

### Options and playbook {#playbooks}

**Playbook** selects the coordinator's working method: Flexible mission, Debugging, Exploration, Product delivery or Compare two models. [Playbooks](playbooks.md) describes their roles and steps.

The playbook guides the agents within their native permissions. Commits, pushes, pull requests and issue-tracker changes require an explicit request for that action in the objective or Notes.

### Delegation and depth {#profiles}

**Task sessions** selects **Native subagents** under the coordinator, or **Independent sessions**. Both remain subject to OpenCode permissions and nesting limits.

**Subagent depth** is a project setting for all its OpenCode conversations. Choose **Inherit** or a depth from 1 to 10; this choice is saved immediately. Its **ⓘ** shows the observed effective depth, nesting permissions and configuration paths.

The subagent-depth information identifies its effective source under **OpenCode configuration file:**.

Saving a project depth also enables subagents to delegate within that depth, overriding General restrictions from other configuration files where supported. **Inherit** removes the added rule. Saving does not reload OpenCode or change running conversations.

### Agents and models {#agents-models}

Expand **Agents and models** to edit one Agent / Model / Thinking row per role. The summary keeps the requested choices visible when folded. Creation starts from the defaults in Preferences; changes here apply to this Mission.

The Missions gear opens the defaults for **All missions** or a particular playbook. Preferences save each change immediately. Model lists follow the conversation selector's visibility and favorites settings; a saved model outside the list stays selected.

**Compare two models** requires different models for A and B; changing Thinking alone does not make a different model. The blind judge uses the coordinator's model unless you choose another one. Using A or B as judge can bias the comparison.

Calendar-backed scheduling requires an explicit agent and model for the coordinator and every playbook role.

### Start automatically {#automatic-start}

**Start automatically** is outside Scheduling and off by default. Leave it off to create a paused Mission, then use ▶ **Start** in the header. Turn it on to request Start after creation is confirmed, with the ordinary checks and automatic scheduling preparation.

### Keep coordinator active with /goal {#coordinator-goal}

**Keep coordinator active with /goal** is available for one-time Missions and off by default. When enabled, starting the Mission arms OpenCode `/goal` on the coordinator, pausing and resuming the Mission pauses and resumes that goal, and finishing or stopping clears it. If OpenCode restarts while the Mission is running, Missions resumes the restart-paused goal automatically (including when CodeNomad is closed, if OpenCode automations are enabled), while leaving manual, stall, or round-limit pauses untouched. The live goal status and controls appear in the Mission overview.

## Scheduling {#daily-schedules}

A Mission with a repeating schedule or an event stays one row in the list: each launch replaces the previous one in the same coordinator conversation, and waits while the previous launch is still active. Its detail shows **Launch when**, **Desired state**, the next wake or check, **Launched passages** and **Past runs** (the last 20 launches). With **Start automatically** off, it is created paused. **Edit selected mission** reopens the creation form, and the next launch uses what you save. **Delete selected mission…** removes its scheduling first. ⏸ in the toolbar pauses it whole, the launch under way and its scheduling, and ▶ resumes both. ■ stops the launch under way; once nothing runs, it stops the scheduling permanently and leaves the Mission in the list.

### Criteria {#native-scheduling}

The **i** button opens [scheduling help](missions.md#native-scheduling).

The first criterion is **Once, now**. **Add a criterion** adds another; choose its type, remove it with ×, or reorder cards by their grip. Alt+Up/Down moves a focused grip.

Schedules include Once, now, Every N hours, Every day, Selected weekdays, Day of each month and Advanced (cron). Civil schedules use the saved time zone. **Saved time zone (IANA)** appears when it differs from the system zone. Months without the chosen day are skipped.

**Once, now** takes its instant at Start, rather than when the form opens. It offers one opportunity, which a condition can consume without launching. Choose a repeating schedule for later opportunities. Scheduling runs while its OpenCode service and execution host are available.

Starting or resuming prepares scheduling in the project's OpenCode configuration automatically.

### Events and combinations {#scheduling-conditions}

Choose **Repository activity → Event**, then any optional filters in the same card. Git branch commits share this menu with events from the automatically detected GitHub, GitLab or Gitea repository, using the same detection as Contribute (`upstream`, then `origin`). All three support new PRs/MRs, merged PRs/MRs and new issues, with optional **Author**, including `dependabot[bot]`. Choosing an event fixes its repository; saved criteria retain their targets.

Forge checks use `gh`, `glab` or `tea` on the OpenCode execution host, including with CodeNomad closed; public repositories can use anonymous access. Self-hosted forges require a CLI signed in to that host. **github.com** also offers account notifications and Dependabot alerts through signed-in `gh`, with [notification access](https://docs.github.com/en/rest/activity/notifications) or [alert read access](https://docs.github.com/en/rest/dependabot/alerts). Notifications preserve read status; alerts include fixed or dismissed items. Stored notifications with an empty **GitHub repository** cover the account. First Start sets the reference.

An event can follow commits on a local branch, new messages in a conversation, or changes to explicit files. Choose the source inside that criterion. Search ignores letter case, including accented letters. During a search, use **Load more sources** inside the picker to continue, whether or not the current page has matches. The new-message criterion's selected conversation also supplies context to the passage. Changing the criterion type clears its source. Editing keeps stored conversation context.

- **or** combines adjacent schedules, or adjacent events.
- **if**: events after schedules are their conditions. At each scheduled time, one of those events must have changed since the last successful passage.

Events at the beginning can launch a passage on each new occurrence; trigger events are checked every 15 minutes. First Start establishes the source reference. A successful passage advances it; failed work keeps it. Passages do not overlap.

### Counts and history {#scheduling-limits}

**Coordinator session** defaults to **New session** for every passage. With a schedule or event, **Existing session** lets you select a root conversation in this project and execution Location. Each passage continues there with the configured agent and model, preserving its transcript, title and permissions. Mission controls also affect work already in that conversation. Each passage keeps its own result and journal in **Past runs**. At each launch the conversation is put on the coordinator's agent, model and thinking.

You can ask an agent to prepare the schedule using its current root conversation. Passages wait for the conversation to be idle.

A saved policy that the editor cannot represent stays under **Stored scheduling policy** until you explicitly replace it. Review any retained end or launch limit before editing.

In **Followed conversations**, use **Add conversation** and choose a conversation, for an immediate Mission. Before Play, change a selection or use its × button to remove it.

Choose **New commits on a local branch** to watch a local Git ref, or **New commits on a remote branch** and enter the branch name (for example `dev`). The remote check reads the detected repository directly, without a local fetch. Several commits between checks produce one passage.

## Follow the tree and read results {#tracking}

The chevron expands or collapses a Mission's tasks. Clicking a row selects the Mission or task; actions for that selection stay in the header. A Mission without tasks has no chevron. **Filter missions** filters the loaded directory. One-time and recurring Missions share one list, latest activity first; a running scheduled run comes first.

The eye toggles **Summary** in the central reader and follows your selection while pressed. Use **Open conversation** to go to the coordinator or selected task. **More actions** (⋯) contains the applicable update, interruption, save-configuration and edit commands.

Selection, expanded sections and the reader belong to each project tab and restore with it. Duplicate tabs can read different reports or keep a report in one and the conversation, a file or a web preview in another. Opening or closing a reader changes only that tab; Mission work and completion acknowledgements remain shared within the window.

More directory entries and tasks load as you approach the end. If loading tasks fails, use **Try again** to continue.

### Colours and states {#status-colours}

The flag shows the Mission's state; its chevron carries its tasks' attention state. A recurring entry uses a repeat icon.

| Colour and shape | Meaning |
| --- | --- |
| Red | An open question or permission needs your answer. Select the asking Mission or task to open the interruption dock. |
| Yellow | Native work was observed running. |
| Orange pause symbol | Paused: nothing continues or launches until you resume it. |
| Orange warning triangle | Interrupted, with an action to continue. |
| Green | A Mission, task or successful scheduled run awaits review in this window. |
| Accent hourglass | **Waiting for scheduled run**: the next wake is confirmed. The accent follows your palette. |
| Accent icon alone | Prepared Mission or a task that has not started. |
| Neutral | Reviewed completion or stopped schedule; read the status text. |

Select a green Mission or task, click or sweep green task icons, or use **Mark as read** on the chevron's context menu. For **Successful run to review**, explicitly select the recurring row in the active window or use **Mark as read**. Its icon returns to waiting while scheduling remains active, otherwise neutral. New results arriving on an already selected row stay unread.

Retiring a task keeps its history.

### Questions and decisions {#questions}

The coordinator is instructed to resolve what it can and ask you only for remaining decisions, consent or credentials. Answer through the interruption dock. Exploration results distinguish **Coordinator decision** from **Your answer**; with Independent sessions, decisions are recorded in Notes. [Playbooks](playbooks.md) explains those workflows.

### Briefings and update requests {#briefings}

The coordinator is instructed to publish briefings at key milestones. They are its assessment, not a live activity counter. **Request an update** under More actions asks for another; read it through Summary.

## Context and results {#context-flow}

A new Mission or scheduled passage has its own plan. Put useful previous results into its Objective or Notes, or ask the coordinator to find them.

### Search earlier conversations {#context-search}

While CodeNomad is running, agents can search saved conversations in this project. Ask explicitly when earlier conclusions matter; a separate Mission does not automatically inherit another conversation's full context.

## Closing CodeNomad and restarting services {#lifetime}

Closing a project or CodeNomad does not stop native OpenCode work. Armed native schedules can run with CodeNomad closed while the service and execution host are available. A healthy native schedule resumes its calendar after a service restart; explicit pauses, stops and unresolved outcomes keep their barriers.

Some coordination and recovery actions need the CodeNomad backend.

A running one-time Mission keeps assigning its tasks and delivering their reports while no CodeNomad window has the project open. Environment variables and permission settings changed in CodeNomad apply to those conversations again once the project is open.

## Pause, Stop and unconfirmed actions {#controls-recovery}

One-time **Pause** lets current steps finish without starting new work. **Interrupt now** requests immediate interruption. **Stop** is terminal and asks for confirmation. Native schedule Pause closes future admission and requests interruption of its current passage. Tool effects may continue after an interruption; inspect partial results.

Keep an unconfirmed action's original request: while a native schedule or editor view is open, CodeNomad rereads it automatically until it settles and automatically retries only an exact recorded partial preparation. Use **Check status** for one-time Mission controls, and **Refresh mission map** for ordinary one-time creation when offered; do not create a replacement to bypass uncertainty.

An interrupted or failed one-time Mission can offer **Recover interrupted mission**. Eligible tasks offer missing-report recovery.

## Edit, delete and conversation cleanup {#cleanup}

Task-conversation cleanup is a one-time Mission option. Native schedule deletion retains conversations.

**Edit selected mission**, under More actions, opens the shared form. Before first launch, preparation fields can be edited when unlocked. After launch, instructions and Notes remain editable where allowed; explanations beside locked fields name the restriction.

Stop work before deleting it. **Delete selected mission…** removes a one-time Mission at once. Schedule deletion closes future launches first.

To also remove eligible task conversations, enable **Deleting a mission also deletes its task conversations** in Missions Preferences. Coordinators, reused or shared conversations and conversations whose ownership cannot be established are kept. **Conversation cleanup** shows remaining cleanup and explicit retries. Removing a saved configuration does not delete a Mission.
