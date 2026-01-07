---
applyTo: '**'
---

# Fork Metadata
- Original Repo: https://github.com/NeuralNomadsAI/CodeNomad.git (trueupstream)
- Fork Repo: https://github.com/bizzkoot/CodeNomad (origin)
- Last Sync Date: 2026-01-07
- Merge Branch: merge/upstream-7Jan2025
- Last Sync Commit: origin/dev (ee8827c)
- Upstream Commit: trueupstream/dev (c825ff0)
- Upstream Commits Merged: 25 commits (v0.5.0 → v0.5.1)
- Fork Version: 0.5.1-custom

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

## 2026-01-07 - Phase-by-Phase Merge SUCCESS ✅
- Strategy: Phased merge (9 phases, 25 commits)
- Upstream Status: 25 commits merged from trueupstream/dev (v0.5.0 → v0.5.1)
- Fork Status: ALL custom features preserved
- Merge Branch: merge/upstream-7Jan2025
- Final Commits: 12 commits (11 cherrypicks + 1 version bump + 1 typecheck fix)

### Merge Phases Executed
1. **Phase 1**: CI/Build improvements (12 upstream commits) - Tauri retry logic, Windows fixes
2. **Phase 2**: Package configuration (exclude opencode-config, dependencies)
3. **Phase 3**: iOS auto-zoom bug fix (utilities.css)
4. **Phase 4**: Version-aware global cache
5. **Phase 5**: Session status indicators (instance-tab, shield icon)
6. **Phase 6**: Session optimizations (status updates, hydration fixes)
7. **Phase 7**: Compaction indicators (timeline, message stream)
8. **Phase 8**: Version bump to 0.5.1-custom
9. **Phase 9**: TypeScript error fixes (reconcilePendingPermissionsV2)

### Conflicts Resolved
1. **session-api.ts** - Merged status derivation removal with permission reconciliation
2. **bridge.ts** - Added missing reconcilePendingPermissionsV2 function from upstream
3. **CI workflows** - Resolved Tauri CLI installation conflicts (accepted upstream retry logic)

### All Custom Features PRESERVED ✅
- ✅ Command suggestions (command-suggestion-item.tsx, command-suggestions.tsx, command-filter.ts)
- ✅ Folder tree browser (folder-tree-browser.tsx, folder-tree-node.tsx)
- ✅ Markdown preview (markdown-preview-icon.tsx, markdown-preview-modal.tsx, use-markdown-preview.ts)
- ✅ Permission notification banner (permission-notification-banner.tsx)
- ✅ All custom utilities (file-path-validator.ts, markdown-file-detector.ts)
- ✅ All custom styles (command-suggestions.css, markdown-preview.css, permission-notification.css, folder-tree-browser.css)

### Upstream Features Integrated ✅
- ✅ Session status indicators & optimizations
- ✅ Compaction indicators in message stream and timeline
- ✅ iOS input auto-zoom fix
- ✅ Version-aware global cache
- ✅ Shield icon for permission status
- ✅ Tauri CLI retry logic for all platforms
- ✅ Windows opencode-config isolation
- ✅ Permission reconciliation after message hydration
- ✅ Dev CI build-only workflow

### Tests Status
- TypeScript: ✅ PASSED (0 errors)
- VSCode Errors: ✅ PASSED (0 errors)
- Build: ⏳ PENDING (awaiting user testing)
- Custom Features: ✅ ALL FILES VERIFIED PRESENT

### Key Technical Changes
1. **Status Handling**: Removed deriveSessionStatusFromMessages (status now from API)
2. **Permission System**: Added reconcilePendingPermissionsV2 for proper hydration
3. **CI/CD**: Upgraded to Tauri CLI 2.9.4 with retry logic
4. **Package Management**: Excluded opencode-config from workspaces

## 2026-01-05 - Successful Merge & Build Complete ✅
- Strategy: Hybrid (Auto-merge + Manual conflict resolution)
- Upstream Status: 8 commits merged from trueupstream/dev
- Origin Status: 14 custom commits preserved
- Merge Branch: merge/trueupstream-dev-2026-01-05
- Merge Commit: 1559983

### Conflicts Resolved
1. **package-lock.json** - Accepted upstream, regenerated with npm install
2. **message-item.tsx** - Kept origin's `onOpenPreview` prop
3. **commands.ts** - Merged upstream's error handling with origin's debug logs

### Post-Merge Fixes
1. Added missing `fuzzysort` dependency (^3.1.0)
2. Fixed TypeScript type compatibility in permission-approval-modal.tsx
   - Changed `Permission` to `PermissionRequestLike` to match upstream types
3. All TypeScript compilation passed ✅
4. macOS ARM64 build successful ✅ (131MB zip file)

### Tests Status
- TypeScript: ✅ PASSED (0 errors)
- Build: ✅ SUCCESS (packages/electron-app/release/CodeNomad-0.4.0-mac-arm64.zip)
- Runtime: Awaiting user testing

### Integrated Upstream Features
- ✅ v2 SDK client migration (@opencode-ai/sdk 1.1.1)
- ✅ Unified ANSI rendering with sequence parser
- ✅ Session status tracking via SSE updates
- ✅ Background process ANSI output rendering
- ✅ Permission system SDK 1.0.166 updates
- ✅ Copy button functionality improvements

### Preserved Origin Features
- ✅ Folder tree browser with markdown preview
- ✅ Permission notification banner system
- ✅ Command suggestions with shell mode
- ✅ All UI/UX enhancements
- ✅ Web browser compatibility improvements

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
