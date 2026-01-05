## Summary
Successfully merged 8 commits from `trueupstream/dev` (NeuralNomadsAI/CodeNomad) with full preservation of origin custom features.

## Upstream Changes Integrated
- ✅ **v2 SDK client migration** (@opencode-ai/sdk 1.1.1)
  - New OpencodeClient v2 with normalized request handling
  - Permission rehydration via GET /permission
  - 15 files updated for SDK compatibility
- ✅ **Unified ANSI rendering** with ansi-sequence-parser library
  - New `lib/ansi.ts` module
  - Background process output with ANSI color support
- ✅ **Session status tracking** via SSE updates
- ✅ **Permission system updates** for SDK 1.0.166 compatibility
  - New `types/permission.ts` with `PermissionRequestLike` type
  - permission.asked events and requestID replies
- ✅ **Copy button improvements** for web browsers

## Origin Features Preserved
- ✅ Folder tree browser with markdown preview (Issue #3)
- ✅ Permission notification banner system (Issue #4)
- ✅ Command suggestions with shell mode
- ✅ All custom UI/UX enhancements
- ✅ Web browser compatibility improvements
- ✅ Debug logging in commands store

## Conflicts Resolved
1. **package-lock.json** - Accepted upstream, regenerated
2. **message-item.tsx** - Preserved `onOpenPreview` prop
3. **commands.ts** - Merged upstream error handling with origin debug logs

## Post-Merge Fixes
- Added `fuzzysort` dependency (^3.1.0) for command filtering
- Fixed TypeScript type compatibility in `permission-approval-modal.tsx`
- All TypeScript compilation passed (0 errors)

## Testing
- ✅ **TypeScript**: All packages typecheck successfully
- ✅ **Build**: macOS ARM64 build successful (131MB)
- ✅ **Runtime**: Pending manual testing

## Build Artifacts
- macOS ARM64: `packages/electron-app/release/CodeNomad-0.4.0-mac-arm64.zip`

## Commits
- 1559983: Merge trueupstream/dev changes (v2 SDK + ANSI improvements)
- 0c4e9d5: Post-merge type fixes and missing dependencies

## Review Checklist
- [ ] Test app launches successfully
- [ ] Verify folder tree browser works
- [ ] Verify permission notification banner works
- [ ] Verify command suggestions work
- [ ] Test ANSI rendering in background processes
- [ ] Confirm no regressions in existing features
