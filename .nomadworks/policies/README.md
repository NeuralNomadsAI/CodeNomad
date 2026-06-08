# NomadWorks Policies

NomadWorks keeps core workflow behavior in the plugin and lets repositories override opinionated delivery policies here.

## How Policy Resolution Works

For any `<include:policy:<file>.md>` include, NomadWorks resolves policy files in this order:

1. `.nomadworks/policies/<file>.md`
2. bundled plugin default `policies/<file>.md`

Files under `.nomadworks/generated/policies/` are reference copies only. They are not read directly at runtime.

## Available Policies

- `development-guidelines.md`
  - Repository-specific engineering rules, stack notes, and implementation conventions.
  - Used by: `developer`, `technical_architect`, `tech_lead`, `workflow_runner`

- `testing-guidelines.md`
  - Testing, evidence, regression, and verification conventions.
  - Used by: `developer`, `qa_engineer`, `tech_lead`, `workflow_runner`

- `documentation-guidelines.md`
  - Documentation layout, naming, ownership, and update expectations.
  - Used by all agents through the shared prompt.

- `definition-of-ready.md`
  - Canonical readiness criteria before execution begins.
  - Used by all agents through the shared prompt and reflected in task templates.

- `definition-of-done.md`
  - Canonical completion criteria before closure.
  - Used by all agents through the shared prompt and reflected in task templates.

- `git-commit-messaging.md`
  - Commit subject and body rules.
  - Used by: `tech_lead`, `workflow_runner`

- `product-guidelines.md`
  - User story, acceptance criteria, terminology, and product-truth conventions.
  - Used by: `product_manager`, `business_analyst`

- `ui-ux-guidelines.md`
  - UI review standards and visual quality expectations.
  - Used by: `ui_ux_designer`

## Customizing A Policy

1. Set `.nomadworks/nomadworks.yaml` `policies.extract_defaults` to `all` if you want reference copies of all bundled defaults.
2. Inspect `.nomadworks/generated/policies/` for the default files.
3. Copy the policy you want to customize into `.nomadworks/policies/`.
4. Edit the copied file. The repo-local version will override the plugin default automatically.

## Policy Extraction

`policies.extract_defaults` supports:

- `none`: do not generate reference policy files
- `all`: write all bundled default policy files to `.nomadworks/generated/policies/`

Only files in `.nomadworks/policies/` affect runtime prompt behavior.
