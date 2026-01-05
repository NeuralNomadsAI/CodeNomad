---
applyTo: '**'
---

# Fork Metadata
- Original Repo: https://github.com/NeuralNomadsAI/CodeNomad.git (trueupstream)
- Fork Repo: https://github.com/bizzkoot/CodeNomad (origin)
- Last Sync Date: 2026-01-05
- Merge Branch: merge/trueupstream-dev-2026-01-05
- Last Sync Commit: origin/dev (f3a51c3)
- Upstream Commit: trueupstream/dev (1377bc6)
- Upstream Commits Ahead: 8 commits
- Origin Commits Ahead: 14 commits

# Custom Modifications Registry

## Origin Custom Features (14 commits ahead)

1. **Clipboard Functionality Enhancement**
   - f3a51c3: Fix clipboard functionality in web browsers
   - Added lib/clipboard.ts with modern Clipboard API and fallback

2. **Folder Tree Browser & Markdown Preview (Major Feature)**
   - 82719ab: Enforce max-height and fix footer visibility
   - 74c0318: Remove hardcoded max-height from folder tree browser body
   - 2023a68: Add folder tree browser with markdown preview (Issue #3)
   - b32123a: Fix shell mode slash detection and markdown preview for edit tool
   - New components: folder-tree-browser.tsx, folder-tree-node.tsx, markdown-preview-icon.tsx, markdown-preview-modal.tsx
   - New utilities: file-path-validator.ts, markdown-file-detector.ts, use-markdown-preview.ts
   - New styles: folder-tree-browser.css, markdown-preview.css

3. **Permission Notification System (Major Feature)**
   - 80175fb: Add Files and Permission buttons to phone portrait layout
   - 409f160: Improve phone portrait toolbar button visibility
   - ddd58bb: Improve web browser visibility for folder tree and permission buttons
   - bfb5d4b: Resolve permission modal styling and web browser visibility issues
   - 980a8c8: Add global permission notification system (Issue #4)
   - New components: permission-notification-banner.tsx, permission-approval-modal.tsx (modified)
   - New styles: permission-notification.css

4. **Command Suggestions (Major Feature)**
   - 126797c: Allow / to trigger commands when in shell mode
   - 2cc3332: Fix markdown preview & add command suggestions debugging
   - 65b5dfe: Complete Phase 2 integration - command suggestions & markdown preview
   - afe1841: Phase 1 complete - command suggestions & markdown preview utilities
   - New components: command-suggestions.tsx, command-suggestion-item.tsx
   - New utility: command-filter.ts
   - New styles: command-suggestions.css

## Upstream Changes (8 commits ahead)

### 🟢 SAFE TO MERGE (Low Risk)
1. **3c450c0**: Fix copy button functionality in web browsers
   - Risk: LOW - We already have similar fix (f3a51c3)
   - Strategy: Compare and merge improvements

2. **a041e1c**: Track session status via SSE updates
   - Risk: LOW - Enhancement to session tracking
   - Files: session-api.ts, session-events.ts, session-state.ts, session-status.ts, sessions.ts, session.ts
   - Impact: Improves session status monitoring

3. **c2df32e, f01149e**: Stream ANSI tool output rendering (duplicates)
   - Risk: LOW - Package-lock changes
   - Strategy: Auto-merge

### 🟡 CAUTION MERGE (Medium Risk - Overlapping Changes)
4. **4571a1d**: Render ANSI background output
   - Risk: MEDIUM - We modified ANSI rendering (3606d9a)
   - Files: background-process-output-dialog.tsx, lib/ansi.ts (NEW in upstream)
   - Conflict: We have ansi rendering in tool-call output, they added lib/ansi.ts module
   - Strategy: Keep our implementations, integrate their ansi.ts library

5. **eebfcb5**: Unify ANSI rendering with sequence parser
   - Risk: MEDIUM - Refactors ANSI to use unified parser
   - Files: background-process-output-dialog.tsx, lib/ansi.ts
   - Impact: Better ANSI parsing architecture
   - Strategy: Integrate their ansi.ts, adapt our code to use it

### 🔴 HIGH RISK (Breaking Changes - Requires Analysis)
6. **fcb5998**: Update UI permissions for SDK 1.0.166
   - Risk: HIGH - Major permission system changes
   - Files: instances.ts, session-events.ts, message-v2/bridge.ts, types/permission.ts (NEW), tool-call.tsx
   - Conflict: DIRECT - We heavily modified permission system
   - Changes: New permission.asked events, requestID replies, types/permission.ts file
   - Strategy: MANUAL MERGE REQUIRED - Our permission notification banner vs their permission.asked events

7. **1377bc6**: Migrate UI to v2 SDK client (BREAKING)
   - Risk: CRITICAL - Complete SDK migration
   - Files: 15 files modified including instances.ts, session-*.ts, sdk-manager.ts
   - Conflict: CRITICAL - We modified instances.ts, session-events.ts, session-api.ts
   - Changes: New OpencodeClient v2, normalized request handling, permission rehydration
   - Package: @opencode/sdk 1.0.166 -> 2.x
   - Strategy: REQUIRES USER DECISION

# Merge History

## 2026-01-05 - Upstream Merge Analysis (Phase 1 Complete)
- Strategy: Hybrid (Auto + Manual Decision Required)
- Upstream Status: 8 commits ahead (7 unique + 1 duplicate)
- Origin Status: 14 commits ahead (unique custom features)
- Merge Branch: merge/trueupstream-dev-2026-01-05
- Conflicts Detected: HIGH RISK on 2 commits
  - fcb5998: Permission system SDK changes (overlaps with our permission notification)
  - 1377bc6: v2 SDK migration (BREAKING - touches 15 core files)
- Safe Merges: 3 commits (copy button, session status, ANSI package-lock)
- Caution Merges: 2 commits (ANSI rendering architecture)
- Manual Decision: 2 commits (permission SDK, v2 migration)
- Tests: Pending merge execution

## File Conflict Analysis
### Critical Overlaps (Both branches modified)
- ✅ packages/ui/src/lib/clipboard.ts - SAFE (we added, they have similar fix in different files)
- 🔴 packages/ui/src/stores/instances.ts - CRITICAL (v2 SDK changes + our permission banner)
- 🔴 packages/ui/src/stores/session-events.ts - HIGH (session status + our modifications)
- 🟡 packages/ui/src/stores/session-api.ts - MEDIUM (v2 SDK + our changes)
- 🟡 packages/ui/src/components/tool-call.tsx - MEDIUM (permission requestID + our rendering)
- 🟡 packages/ui/src/lib/ansi.ts - MEDIUM (they added new file, we have inline rendering)
- 🔴 packages/ui/src/types/permission.ts - HIGH (they added new file with types, we may have conflicts)

# Merge Patterns

## Safe Patterns
- New files in upstream that don't conflict with fork modifications
- Documentation updates
- Dependency patches
- Test additions (not modifications)

## Risk Patterns
- Changes to folder tree browser implementation
- Permission system modifications
- Command suggestion logic changes
- Background process manager updates
- OpenCode config changes
- UI component modifications (high customization in fork)

## Failed Approaches
- None recorded yet

# Notes
- Fork has significant custom features not present in upstream
- Strong divergence in UI/UX implementation
- Custom plugin system integration
- Web browser compatibility enhancements
- All features are production-ready based on TEST_REPORT_PHASE2.md
