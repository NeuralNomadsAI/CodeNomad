# Repository Agent Additions

Place additive prompt fragments here to append repository-specific instructions to an existing agent.

- Use `.nomadworks/agent-additions/<agent>.md` to add instructions to a bundled or custom repo agent.
- The matching base agent must exist in the plugin bundle or `.nomadworks/agents/`.
- `README.md` is ignored by agent discovery.

## Include Types Available In Additions

Agent additions can use the same include resolution as bundled agents and custom agents:

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

## Available Policy Includes

- `policy:development-guidelines.md`
- `policy:testing-guidelines.md`
- `policy:documentation-guidelines.md`
- `policy:git-commit-messaging.md`
- `policy:product-guidelines.md`
- `policy:ui-ux-guidelines.md`
