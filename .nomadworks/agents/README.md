# Repository Agents

Place full repository-local agent definitions here.

- Use `.nomadworks/agents/<agent>.md` to override a bundled agent's full base definition.
- Use `.nomadworks/agents/<agent>.md` to define a brand new custom repository agent.
- Files in this folder are treated as full agent definitions.
- `README.md` is ignored by agent discovery.

## Include Types Available In Custom Agents

Custom agents can use the same include resolution as bundled agents:

- `<include:plugin:...>` for plugin-owned shared guidance
- `<include:policy:...>` for repository-overridable policy files with bundled defaults
- `<include:repo:...>` for explicit files under `.nomadworks/`

## Common Plugin Includes

- `plugin:Agents_Common.md`
- `plugin:docs/core/agent_orchestration.md`
- `plugin:docs/core/communication_guidelines.md`
- `plugin:docs/core/discussion_agent_guidelines.md`
- `plugin:docs/core/role_contracts.md`
- `plugin:docs/core/task_model.md`
- `plugin:docs/core/codemap_conventions.md`
- `plugin:docs/core/pma_mode_full.md`
- `plugin:docs/core/pma_mode_mini.md`
- `plugin:docs/core/tech_lead_mode_full.md`
- `plugin:docs/core/tech_lead_mode_mini.md`

## Available Policy Includes

- `policy:development-guidelines.md`
- `policy:testing-guidelines.md`
- `policy:documentation-guidelines.md`
- `policy:git-commit-messaging.md`
- `policy:product-guidelines.md`
- `policy:ui-ux-guidelines.md`
