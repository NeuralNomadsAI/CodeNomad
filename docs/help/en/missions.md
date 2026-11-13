# Missions

A Mission keeps an objective, a coordinator conversation, tasks and their results together. Open **Missions** in the right panel.

## Create a Mission {#create}

Remote connections use the same form and controls. Prefer HTTPS to protect network traffic.

Choose **Create mission**. The form replaces the tree until you create or cancel. Its groups follow the order below.

### Configuration {#saved-briefs}

**Configuration** optionally loads a saved objective, notes, playbook, agents/models and task-session choices. Its name supplies the editable title. Check the filled fields before creating.

**Save configuration**, in the footer beside Cancel and Create, names and saves a reusable configuration. It does not create or start a Mission. Scheduling and **Start automatically** are separate choices. The Missions gear opens Preferences, including the saved-configuration library; removing a configuration keeps existing missions and conversations.

### Objective, Title and Notes {#mission-instructions}

- **Objective**: the result you want and how to check it.
- **Title**: the name in the tree. For a blank Mission it follows the objective's first sentence, up to 60 characters; you can edit it.
- **Notes**: optional context, constraints or additional instructions for the agents. Keep information needed to do the work here, rather than UI settings.

### Options and playbook {#playbooks}

**Playbook** selects the coordinator's working method: Flexible mission, Debugging, Exploration, Product delivery or Compare two models. [Playbooks](playbooks.md) describes their roles and steps.

The playbook guides the agents within their native permissions. Commits, pushes, pull requests and issue-tracker changes require an explicit request for that action in the objective or Notes.

### Delegation and depth {#profiles}

**Task sessions** selects **Native subagents** under the coordinator, or **Independent sessions**. Both remain subject to OpenCode permissions and nesting limits.

**Subagent depth** is a project setting for all its OpenCode conversations. Choose **Inherit** or a depth from 1 to 10; this choice is saved immediately. Its **ⓘ** shows the observed effective depth, nesting permissions and configuration paths. A failed or unconfirmed save keeps its warning and offers an explicit refresh.

Saving a project depth also enables subagents to delegate within that depth, overriding General restrictions from other configuration files where supported. An incompatible project rule keeps its warning. **Inherit** removes the added rule. Saving does not reload OpenCode or change running conversations.

### Agents and models {#agents-models}

Expand **Agents and models** to edit one Agent / Model / Thinking row per role. The summary keeps the requested choices visible when folded. Creation starts from the defaults in Preferences; changes here apply to this Mission.

The Missions gear opens the defaults for **All missions** or a particular playbook. Preferences save each change immediately. Model lists follow the conversation selector's visibility and favorites settings; a saved model outside the list stays selected.

**Compare two models** requires different models for A and B; changing Thinking alone does not make a different model. The blind judge uses the coordinator's model unless you choose another one. Using A or B as judge can bias the comparison.

Calendar-backed scheduling requires an explicit agent and model for the coordinator and every playbook role.

### Start automatically {#automatic-start}

**Start automatically** is outside Scheduling and off by default. Leave it off to create a paused Mission, then use ▶ **Start** in the header. Turn it on to request Start after creation is confirmed, with the ordinary checks and any required native-settings consent.

If creation's acknowledgement is lost, reading its receipt leaves Start manual. An unconfirmed creation keeps its original request; inspect the list and conversation before creating anything again.

## Scheduling {#daily-schedules}

### Criteria {#native-scheduling}

The subagent-depth information identifies its effective source under **OpenCode configuration file:**.

The first criterion is **Once, now**. **Add a criterion** adds another; choose its type, remove it with ×, or reorder cards by their grip. Alt+Up/Down moves a focused grip.

Schedules include Once, now, Every N hours, Every day, Selected weekdays, Day of each month and Advanced (cron). Civil schedules use the saved time zone. **Saved time zone (IANA)** appears when it differs from the system zone. Months without the chosen day are skipped.

**Once, now** takes its instant at Start, rather than when the form opens. It offers one opportunity, which a condition can consume without launching. Choose a repeating schedule for later opportunities. Scheduling runs while its OpenCode service and execution host are available.

Starting or resuming prepares scheduling in the project's OpenCode configuration automatically. An explicit OFF is preserved: use **Open scheduling settings** when offered to open the responsible file, and the **i** tip for its source or environment details. The clicked button shows loading only during the request. An unconfirmed result offers verification; recovered activation leaves Start explicit.

### Events and combinations {#scheduling-conditions}

Choose **Repository activity → Event**, then any optional filters in the same card. Git branch commits share this menu with events from the automatically detected GitHub, GitLab or Gitea repository, using the same detection as Contribute (`upstream`, then `origin`). All three support new PRs/MRs, merged PRs/MRs and new issues, with optional **Author**, including `dependabot[bot]`. Choosing an event fixes its repository; saved criteria retain their targets.

Forge checks use `gh`, `glab` or `tea` on the OpenCode execution host, including with CodeNomad closed; public repositories can use anonymous access. Self-hosted forges require a CLI signed in to that host. **github.com** also offers account notifications and Dependabot alerts through signed-in `gh`, with [notification access](https://docs.github.com/en/rest/activity/notifications) or [alert read access](https://docs.github.com/en/rest/dependabot/alerts). Notifications preserve read status; alerts include fixed or dismissed items. Stored notifications with an empty **GitHub repository** cover the account. First Start sets the reference. Checks read at most four pages of 50 items within ten seconds; missing access, rate limits or incomplete windows leave the source unavailable. Observed summaries enter the passage input and are consumed after success.

An event can follow another schedule's success, a completed one-time Mission, commits on a local branch, new messages in a conversation, or changes to explicit files. Choose the source inside that criterion. Browsing without a search loads more as you scroll; a failed read offers **Try again** there. Search ignores letter case, including accented letters. During a search, use **Load more sources** inside the picker to continue, whether or not the current page has matches. The new-message criterion's selected conversation also supplies context to the passage. Changing the criterion type clears its source. Editing keeps stored conversation context.

- **or** combines adjacent schedules, or adjacent events.
- **if**: events after schedules are their conditions. At each scheduled time, one of those events must have changed since the last successful passage.
- **else**: schedules after events are a fallback. At their time, they run only if the criteria above launched no passage since that schedule's previous slot, or since it was armed. Events after the fallback condition that fallback.

Events at the beginning can launch a passage on each new occurrence; trigger events are checked every 15 minutes. First Start establishes the source reference. A successful passage advances it; failed work keeps it. Missing or unreadable sources block with an explanation. Passages do not overlap.

### Counts and history {#scheduling-limits}

**Coordinator session** defaults to **New session** for every passage. With a schedule or event, **Existing session** lets you select a root conversation in this project and execution Location. Each passage continues there with the configured agent and model, preserving its transcript, title and permissions. Mission controls also affect work already in that conversation. Each passage keeps its own result and journal in **Past runs**; a missing selected conversation requires your intervention.

Select a schedule to read its state, next wake or check, launched and successful passage counts, and **Past runs**. The history retains 30 results; lifetime counts remain. **Run now** counts as a launched passage once admitted.

A saved policy that the editor cannot represent stays under **Stored scheduling policy** until you explicitly replace it. Review any retained end or launch limit before editing.

### Existing daily schedules {#existing-daily-schedules}

Existing daily entries keep their own controls and saved time zone. After a service restart they show **Interrupted** and require **Resume**. They catch up the latest eligible day rather than running every missed day. Read their retained results through the selected entry.

## Follow the tree and read results {#tracking}

The chevron expands or collapses a Mission's tasks. Clicking a row selects the Mission or task; actions for that selection stay in the header. A Mission without tasks has no chevron. **Filter missions** filters the loaded directory.

The eye toggles **Summary** in the central reader and follows your selection while pressed. Use **Open conversation** to go to the coordinator or selected task. **More actions** (⋯) contains the applicable update, interruption, save-configuration and edit commands.

More directory entries and tasks load as you approach the end. Loaded task pages stay cached independently of the rendered rows. A failed read keeps its last display and offers **Try again**. Background reading uses the header's refresh indicator. Reading or retrying a read never starts work.

### Colours and states {#status-colours}

The flag shows the Mission's state; its chevron carries its tasks' attention state. A recurring entry uses a repeat icon.

| Colour | Meaning |
| --- | --- |
| Red | An open question or permission needs your answer. Select the asking Mission or task to open the interruption dock. |
| Yellow, pulsing | Native work was observed running. |
| Orange | Paused or interrupted, with an action to continue. |
| Green | A Mission or task finished and has not been seen in this window. Select it, click or sweep green task icons, or use **Mark as read** on the chevron's context menu. |
| Blue | Prepared Mission or a task that has not started. |

Status text distinguishes Assigned, Active, Waiting, Blocked, Done, Failed and Retired. A reported blockage is not necessarily a question for you. A recorded result is not proof that every native operation has stopped. Retiring a task keeps its history.

### Questions and decisions {#questions}

The coordinator is instructed to resolve what it can and ask you only for remaining decisions, consent or credentials. Answer through the interruption dock. Exploration results distinguish **Coordinator decision** from **Your answer**; with Independent sessions, decisions are recorded in Notes. [Playbooks](playbooks.md) explains those workflows.

### Briefings and update requests {#briefings}

The coordinator is instructed to publish briefings at key milestones. They are its assessment, not a live activity counter. **Request an update** under More actions asks for another; read it through Summary. If delivery is unconfirmed, inspect the coordinator conversation before making a separate request.

## Context and results {#context-flow}

The durable plan holds the objective, Notes, task briefs, dependencies, results and plan changes. The coordinator receives the objective, Notes and playbook instructions. Native tasks receive their assignment from their parent; independent tasks also receive their open assignments. Helpers receive the context their parent passes. The blind judge receives anonymized comparison material rather than the objective and Notes.

A new Mission or scheduled passage has its own plan. Put useful previous results into its Objective or Notes, or ask the coordinator to find them. OpenCode may compact a conversation's model context while preserving its stored history.

### Search earlier conversations {#context-search}

While CodeNomad is running, agents can search saved conversations in this project. Ask explicitly when earlier conclusions matter; a separate Mission does not automatically inherit another conversation's full context.

## Closing CodeNomad and restarting services {#lifetime}

Closing a project or CodeNomad does not stop native OpenCode work. Armed native schedules can run with CodeNomad closed while the service and execution host are available. A healthy native schedule resumes its calendar after a service restart; explicit pauses, stops and unresolved outcomes keep their barriers. Existing daily schedules require Resume after a restart.

Some coordination and recovery actions need the CodeNomad backend. If Missions is unavailable, follow the panel's connection or plugin error rather than assuming saved work has disappeared.

## Pause, Stop and unconfirmed actions {#controls-recovery}

One-time **Pause** lets current steps finish without starting new work. **Interrupt now** requests immediate interruption. **Stop** is terminal and asks for confirmation. Native schedule Pause closes future admission and requests interruption of its current passage. Tool effects may continue after an interruption; inspect partial results.

Keep an unconfirmed action's original request. Use the offered **Check status**, **Refresh saved request** or retry control; do not create a replacement to bypass uncertainty. Passive refresh and reconnect do not replay it. After confirmation, new actions can remain disabled until an updated view arrives.

An interrupted or failed one-time Mission can offer **Recover interrupted mission**. Eligible tasks offer missing-report recovery. These actions check native activity and outstanding requests before admitting work.

## Edit, delete and conversation cleanup {#cleanup}

Task-conversation cleanup is a one-time Mission option. Native schedule deletion retains conversations.

**Edit selected mission**, under More actions, opens the shared form. Before first launch, preparation fields can be edited when unlocked. After launch, instructions and Notes remain editable where allowed; explanations beside locked fields name the restriction. On conflict, reload the current configuration and inspect **Previous draft for comparison**.

Stop work before deleting it. **Delete selected mission…** removes a one-time Mission at once; a failed or unconfirmed deletion keeps its original **Try again**. Schedule deletion closes future launches first.

To also remove eligible task conversations, enable **Deleting a mission also deletes its task conversations** in Missions Preferences. Coordinators, reused or shared conversations and conversations whose ownership cannot be established are kept. **Conversation cleanup** shows remaining cleanup and explicit retries. Removing a saved configuration does not delete a Mission.
