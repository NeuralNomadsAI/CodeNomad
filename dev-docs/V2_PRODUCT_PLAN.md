# V2 product integration series

Base: `dev@a77e37ef` (OpenCode client/plugin 2.0.18; technical minimum 2.0.7).
The user requested eight individually reviewed PRs, all kept open and unmerged.
Implementation is coordinated in one conversation. Each branch builds on the
preceding reviewed branch; each PR describes only its own delta.

| Order | Branch | Deliverable |
| --- | --- | --- |
| 1 | `feat/v2-01-code-mode` | Native execute script/call presentation |
| 2 | `feat/v2-02-web-results` | Web search results and provider form |
| 3 | `feat/v2-03-skills` | Explicit native skill attachments |
| 4 | `feat/v2-04-web-settings` | Web search configuration and credentials |
| 5 | `feat/v2-05-provider-accounts` | Individual provider accounts |
| 6 | `feat/v2-06-plugin-updates` | Native plugin check/update controls |
| 7 | `feat/v2-07-mcp-code-mode` | Per-server default/on/off Code Mode |
| 8 | `feat/v2-08-usage` | Native usage dashboard |

Every PR needs focused tests, rendered evidence for UI, and an independent
gatekeeper review published on GitHub. Findings are corrected and re-reviewed
until none remain. No PR is merged. Native mutations use isolated test data;
the shared user daemon is not a test target. Runtime requirements follow
demonstrated contracts, not the dependency pin. Track any adjustments and
capability boundaries in the relevant PR rather than silently shrinking scope.

## Contract notes

- Execute: OpenCode 2.0.7 and 2.0.18 `packages/core/src/codemode/tool.ts` expose
  `input.code`, `metadata.toolCalls[]` (`tool`, `status`, optional `input`),
  and `metadata.error`. Individual calls have no result/error text field.
  Native text/file content remains owned by the shared tool output pipeline.
- Web search: verified tagged 2.0.7/2.0.18 `tool/plugin/websearch.ts`.
  Persisted content is Markdown headings, optional Published lines and snippets;
  structured execution output is not part of message history. Consent uses
  `metadata.kind = websearch.provider` and a required string choice/provider.

## Open PRs

- #789: Code Mode; gatekeeper zero findings at `aaee7d5a` after resolving live
  disclosure/focus loss. https://github.com/NeuralNomadsAI/CodeNomad/pull/789#pullrequestreview-5326475808
- #790: Web results/consent; gatekeeper zero findings at `3e443abe`.
  https://github.com/NeuralNomadsAI/CodeNomad/pull/790#pullrequestreview-5326492067

## Skill validation

`scripts/test-prompt-skills-native.mjs` passes against isolated 2.0.7 and
2.0.18 executables: native catalog, ID-only prompt, native skill expansion,
historical attachment identity and queued payload. Location startup registers
plugins progressively; visible catalog demand therefore consumes native skill
and config events, coalesces trailing reads and fences view changes. No local
file scraping or prompt-body skill injection is used.
