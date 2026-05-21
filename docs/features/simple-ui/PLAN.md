# Simple Chat Appearance Plan

## Goal

Add a device-scoped Appearance setting that lets users choose between the current Default chat and a new Simple chat style. Simple should be a CSS-only presentation layer over the chat stream and prompt controls, with calmer tool calls and a materially better mobile chat experience. The only non-CSS product change should be the requested prompt action icon update: send becomes an up arrow, stop remains a stop-square control.

Prototype asset: `docs/features/simple-ui/simple-ui-prototype.png`

Prototype source: `docs/features/simple-ui/simple-ui-prototype.svg`

## Current Code Map

- Appearance settings live in `packages/ui/src/components/settings/appearance-settings-section.tsx`.
- Device UI preferences live in `packages/ui/src/stores/preferences.tsx` under `UiSettings`, with server config persistence already wired through `useConfig()`.
- Theme application lives in `packages/ui/src/lib/theme.tsx`, which already writes `data-theme` to `document.documentElement`.
- Global CSS enters through `packages/ui/src/index.css`, then `tokens.css`, `utilities.css`, `controls.css`, `messaging.css`, `panels.css`, and `markdown.css`.
- Prompt send and stop controls are in `packages/ui/src/components/prompt-input.tsx`; their styles are in `packages/ui/src/styles/messaging/prompt-input.css`.
- The main chat and prompt area are mostly covered by `packages/ui/src/styles/messaging/message-section.css`, `packages/ui/src/styles/messaging/tool-call.css`, `packages/ui/src/styles/messaging/message-base.css`, and `prompt-input.css`.

## Product Design Direction

Scene: a user is running CodeNomad from a phone or narrow browser window while moving between tasks, so the chat should reduce chrome, keep the prompt reachable, and make the latest agent work easier to scan in bright ambient light.

- Keep the Default UI unchanged for existing users.
- Make Simple a restrained chat skin with plain tool calls, compact borders, larger touch targets, and a single calm blue accent used only for primary send.
- Reduce chat visual clutter by removing heavy tool-call backgrounds where spacing and faint dividers are enough.
- Preserve information density on desktop, but make message groups feel like a readable timeline instead of stacked panels.
- Prioritize mobile chat: tool rows compress to a readable inline summary, and the prompt actions sit in a thumb-friendly bottom rail.
- Avoid adding new behavior, new layout state, or alternate component implementations for Simple. The mode should be reversible by switching the setting back to Default.

## Appearance Setting UX

- Add a new card in Appearance above Interaction: `Chat style`.
- Choices: `Default` and `Simple`.
- Scope badge: `Device`, consistent with Theme and Interaction.
- Description copy: `Choose how conversations and prompt controls look on this device.`
- Default choice copy: `Current chat layout and styling.`
- Simple choice copy: `Reduced chat chrome, plain tool calls, and mobile-first prompt controls.`
- Persist as `chatStyle: "default" | "simple"` in `UiSettings`.
- Apply as `data-chat-style="simple"` on `document.documentElement`; remove the attribute for Default or set it to `default` consistently.
- Add i18n keys to every locale file in `packages/ui/src/lib/i18n/messages/*/settings.ts`. If translations are not available, use English placeholders matching the repo's current pattern in several locales.

## Implementation Plan

1. Add preference plumbing.

- Add `export type ChatStylePreference = "default" | "simple"` in `preferences.tsx`.
- Add `chatStyle` to `UiSettings`, `defaultUiSettings`, and `normalizeUiSettings`.
- Expose `setChatStyle` from `useConfig()` using the same `updatePreferences` path as other Appearance settings.
- Keep the default as `default` to avoid behavior changes on upgrade.

2. Apply the selected style globally.

- Add a small UI appearance provider or extend `ThemeProvider` to react to `preferences().chatStyle`.
- Set `document.documentElement.dataset.chatStyle = "simple"` when selected.
- Remove the dataset value or set `default` when not selected.
- Keep this separate from `data-theme`; Simple chat must work with `light`, `dark`, and `system` theme modes.

3. Add Appearance controls.

- In `appearance-settings-section.tsx`, add a `chatStyleOptions` list and render a `settings-choice-grid` card similar to Theme.
- Reuse existing `settings-choice` styles so the new card does not introduce a separate control vocabulary.
- Use icons already in `lucide-solid`, such as `Laptop` for Default and `Sun` for Simple.

4. Add Simple chat CSS as scoped overrides.

- Create new focused files under `packages/ui/src/styles/appearance/`, with `simple-ui.css` as the lean entry import.
- Import it once from `packages/ui/src/index.css` after the existing style entry files so it can override safely.
- Prefix all selectors with `:root[data-chat-style="simple"]` to guarantee Default UI remains unchanged.
- Use existing tokens first. Only add Simple-specific tokens in `tokens.css` if repeated values are needed across more than one area.
- Keep aggregate CSS files lean; do not paste Simple chat rules into `messaging.css`, `controls.css`, or `panels.css`.

5. Update prompt action icons.

- In `prompt-input.tsx`, replace the send fallback `▶` with an up-arrow icon or inline SVG.
- Keep shell mode as the terminal-style icon unless product decides shell submit should also use the up arrow.
- Keep the stop control as a square stop icon, but refine its Simple chat CSS to be compact, tactile, and visually distinct from send.
- Update button titles only if current i18n labels say Play instead of Send.

6. Simple chat CSS scope.

- Tokens: softer surface stack, lighter borders, subtler shadows, consistent `12px` to `16px` radii, minimum touch target around `44px` on coarse pointers.
- Chat header: reduce hard borders without changing global tab or sidebar chrome.
- Messages: reduce per-message chrome, make tool calls plain with no background fill, keep disclosure/dropdown actions inline, keep metrics as small pills only when enabled.
- Prompt: make the textarea feel like a bottom composer, keep attachments/history secondary, place stop and send as large square buttons in the bottom rail.
- Mobile: use `dvh`, safe-area padding, `@media (max-width: 640px)`, and existing container width state on `.session-center-column`.

## Simple Chat Prototype Notes

- The prototype shows the intended result, not final layout code.
- Desktop keeps existing app chrome, with simpler message rows in the working area.
- Mobile keeps existing navigation behavior and presents a focused stream with a sticky composer.
- The send button uses an up arrow. The stop button uses a stop square.

## Testing Plan

- Run `npm run typecheck` after preference and component changes.
- Run `npm run build:ui` to catch CSS import and bundling issues.
- Manually verify Default chat before and after toggling Simple.
- Manually verify Simple chat at desktop width, tablet width, and mobile width around 390px.
- Verify the setting persists after reload.
- Verify `light`, `dark`, and `system` theme modes still work with both Interface Style choices.
- Verify keyboard focus remains visible on settings choices, prompt buttons, and inline tool-call controls.
- Verify coarse pointer behavior: prompt buttons are at least 44px and textarea does not trigger iOS input zoom.

## Risks And Constraints

- CSS-only Simple chat means structural mobile improvements are limited to what the current DOM can support.
- Some current CSS files are large, so Simple chat should live in scoped files rather than expanding existing monoliths.
- Broad selectors could accidentally affect Default UI. Every Simple selector should be scoped under `:root[data-chat-style="simple"]` and target chat/prompt surfaces only.
- Dark theme needs a separate visual pass because Simple chat's light-first direction should not force light mode.
- The send icon update is a markup change, not CSS. It should be isolated to `prompt-input.tsx`.

## Acceptance Criteria

- Appearance has a `Default` vs `Simple` chat style setting.
- Default is selected for existing users and remains visually unchanged.
- Simple chat is activated only through the new data attribute and CSS overrides.
- Simple improves mobile chat readability and thumb reach without removing existing features.
- Prompt send displays an up arrow; stop displays a stop square.
- Prototype PNG exists at `docs/features/simple-ui/simple-ui-prototype.png`.
