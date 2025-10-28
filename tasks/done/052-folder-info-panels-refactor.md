# Task 052 - Folder Selection & Info Panels Refactor

## Goal
Migrate the folder selection view, info view, and logs view to token-driven utilities, removing bespoke gray styling blocks.

## Prerequisites
- Task 051 complete (modal/kbd helpers ready).

## Acceptance Criteria
- [ ] `src/components/folder-selection-view.tsx`, `src/components/info-view.tsx`, and `src/components/logs-view.tsx` use token-backed utilities or shared helpers from `components.css`.
- [ ] Panel surfaces, headers, section dividers, and scroll containers reference tokens rather than raw Tailwind color values.
- [ ] `.session-view` global rule in `src/index.css` is replaced with a utility/helper equivalent.
- [ ] Loading/empty states and action buttons keep their existing behavior and contrast in both themes.

## Steps
1. Catalog remaining raw color classes in the three components.
2. Add reusable panel helpers (e.g., `.panel`, `.panel-header`, `.panel-body`) to `components.css` if helpful.
3. Update component markup to use helpers and token-aware Tailwind classes.
4. Remove residual `bg-gray-*` / `text-gray-*` from these components and clean up `index.css`.

## Testing Checklist
- [ ] Run `npm run build`.
- [ ] Manual spot check: recent folders list, info view logs, logs view streaming; confirm hover states and CTAs.

## Dependencies
- Depends on Task 051.
- Blocks final markdown/global CSS cleanup.

## Estimated Time
1.25 hours

## Notes
- Branch suggestion: `feature/task-052-folder-info-panels-refactor`.
- Capture screenshots (light/dark) of folder selection and logs panels for review.
