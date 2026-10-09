import assert from "node:assert/strict"
import test from "node:test"
import { resolveUpdateFeed, selectPreviewRelease, type GithubReleaseListItem } from "./dev-release-monitor"

const release = (tag: string, publishedAt: string, extra: Partial<GithubReleaseListItem> = {}): GithubReleaseListItem =>
  ({ tag_name: tag, published_at: publishedAt, prerelease: tag.includes("-dev"), ...extra })

// Mirrors the real GitHub ordering: list order is by creation, not version.
const list = [
  release("v0.20.1-dev-20261009-43165435", "2026-10-09T07:16:11Z"),
  release("v0.20.1-dev-20261008-027f5094", "2026-10-08T07:11:59Z"),
  release("v0.20.2-dev-20261010-ffffffff", "2026-10-10T07:00:00Z", { draft: true }),
  release("v0.20.1", "2026-10-03T13:56:24Z"),
  release("v0.20.0-dev-v2-20260901-abcdef12", "2026-09-01T00:00:00Z"),
]

test("an explicit feed wins; the installed label only picks the initial feed", () => {
  assert.equal(resolveUpdateFeed("stable", "0.20.1-dev-20261008-027f5094"), "stable")
  assert.equal(resolveUpdateFeed("preview", "0.20.1"), "preview")
  assert.equal(resolveUpdateFeed(undefined, "0.20.1"), "stable")
  assert.equal(resolveUpdateFeed("dev", "0.20.1"), "stable")
  assert.equal(resolveUpdateFeed(undefined, "0.20.1-dev-20261008-027f5094"), "preview")
  assert.equal(resolveUpdateFeed(undefined, "0.20.0-dev-v2-20260901-abcdef12"), "preview")
})

test("preview offers the newest published non-draft release regardless of dev-v2 labels", () => {
  assert.equal(selectPreviewRelease(list, "0.20.1-dev-20261008-027f5094")?.tag_name, "v0.20.1-dev-20261009-43165435")
  // Stable 0.20.1 is SemVer-newer than its later previews; publication decides.
  assert.equal(selectPreviewRelease(list, "0.20.1")?.tag_name, "v0.20.1-dev-20261009-43165435")
  // A retired dev-v2 line no longer hides the current previews.
  assert.equal(selectPreviewRelease(list, "0.20.0-dev-v2-20260901-abcdef12")?.tag_name, "v0.20.1-dev-20261009-43165435")
  assert.equal(selectPreviewRelease(list, "0.20.1-dev-20261009-43165435"), null)
  // Unknown local builds fall back to version order.
  assert.equal(selectPreviewRelease(list, "0.21.0-dev-local"), null)
  assert.equal(selectPreviewRelease([], "0.20.1"), null)
})
