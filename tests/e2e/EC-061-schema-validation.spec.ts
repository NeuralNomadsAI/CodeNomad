/**
 * EC-061: Configuration Schema Validation
 *
 * Tests the Zod schemas for preferences, tool routing config,
 * and maxSubagentIterations — all from Milestones B1 and B2.
 *
 * These are Node-side tests (no browser needed) that validate
 * the schema layer guarantees correct data shapes, defaults,
 * and boundary enforcement.
 */

import { test, expect } from "@playwright/test"
import {
  PreferencesSchema,
  ToolCategorySchema,
  ToolRoutingSchema,
  ConfigFileSchema,
} from "../../packages/server/src/config/schema"

// ═══════════════════════════════════════════════════════════════════
// SECTION 1: maxSubagentIterations Schema
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-061: maxSubagentIterations Schema", () => {
  test("EC-061-01: defaults to 3 when omitted", () => {
    const result = PreferencesSchema.parse({})
    expect(result.maxSubagentIterations).toBe(3)
  })

  test("EC-061-02: accepts valid value of 1 (minimum)", () => {
    const result = PreferencesSchema.parse({ maxSubagentIterations: 1 })
    expect(result.maxSubagentIterations).toBe(1)
  })

  test("EC-061-03: accepts valid value of 10 (maximum)", () => {
    const result = PreferencesSchema.parse({ maxSubagentIterations: 10 })
    expect(result.maxSubagentIterations).toBe(10)
  })

  test("EC-061-04: accepts value of 5 (middle range)", () => {
    const result = PreferencesSchema.parse({ maxSubagentIterations: 5 })
    expect(result.maxSubagentIterations).toBe(5)
  })

  test("EC-061-05: rejects 0 (below minimum)", () => {
    expect(() => PreferencesSchema.parse({ maxSubagentIterations: 0 })).toThrow()
  })

  test("EC-061-06: rejects 11 (above maximum)", () => {
    expect(() => PreferencesSchema.parse({ maxSubagentIterations: 11 })).toThrow()
  })

  test("EC-061-07: rejects negative numbers", () => {
    expect(() => PreferencesSchema.parse({ maxSubagentIterations: -1 })).toThrow()
  })

  test("EC-061-08: rejects non-integer values", () => {
    expect(() => PreferencesSchema.parse({ maxSubagentIterations: 2.5 })).toThrow()
  })

  test("EC-061-09: rejects string values", () => {
    expect(() => PreferencesSchema.parse({ maxSubagentIterations: "3" })).toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 2: ToolCategorySchema
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-061: ToolCategorySchema", () => {
  const VALID_CATEGORIES = [
    "file-read", "file-write", "execution", "web",
    "planning", "delegation", "search", "navigation",
  ]

  test("EC-061-10: accepts all 8 valid categories", () => {
    for (const cat of VALID_CATEGORIES) {
      const result = ToolCategorySchema.parse(cat)
      expect(result).toBe(cat)
    }
  })

  test("EC-061-11: rejects invalid category string", () => {
    expect(() => ToolCategorySchema.parse("invalid-category")).toThrow()
  })

  test("EC-061-12: rejects empty string", () => {
    expect(() => ToolCategorySchema.parse("")).toThrow()
  })

  test("EC-061-13: rejects numeric values", () => {
    expect(() => ToolCategorySchema.parse(42)).toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 3: ToolRoutingSchema
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-061: ToolRoutingSchema", () => {
  test("EC-061-14: defaults to empty globalDeny and profiles when parsed from {}", () => {
    const result = ToolRoutingSchema.parse({})
    expect(result.globalDeny).toEqual([])
    expect(result.profiles).toEqual({})
  })

  test("EC-061-15: accepts globalDeny with tool names", () => {
    const result = ToolRoutingSchema.parse({
      globalDeny: ["bash", "webfetch"],
    })
    expect(result.globalDeny).toEqual(["bash", "webfetch"])
  })

  test("EC-061-16: accepts profiles with addCategories", () => {
    const result = ToolRoutingSchema.parse({
      profiles: {
        reviewer: {
          addCategories: ["web", "execution"],
        },
      },
    })
    expect(result.profiles.reviewer?.addCategories).toEqual(["web", "execution"])
  })

  test("EC-061-17: accepts profiles with removeCategories", () => {
    const result = ToolRoutingSchema.parse({
      profiles: {
        coder: {
          removeCategories: ["execution"],
        },
      },
    })
    expect(result.profiles.coder?.removeCategories).toEqual(["execution"])
  })

  test("EC-061-18: accepts profiles with addTools and denyTools", () => {
    const result = ToolRoutingSchema.parse({
      profiles: {
        reviewer: {
          addTools: ["bash"],
          denyTools: ["lsp"],
        },
      },
    })
    expect(result.profiles.reviewer?.addTools).toEqual(["bash"])
    expect(result.profiles.reviewer?.denyTools).toEqual(["lsp"])
  })

  test("EC-061-19: rejects invalid category in addCategories", () => {
    expect(() =>
      ToolRoutingSchema.parse({
        profiles: {
          reviewer: {
            addCategories: ["invalid-cat"],
          },
        },
      })
    ).toThrow()
  })

  test("EC-061-20: accepts multiple agent profiles", () => {
    const result = ToolRoutingSchema.parse({
      globalDeny: ["todowrite"],
      profiles: {
        coder: { addCategories: ["web"] },
        reviewer: { denyTools: ["grep"] },
        "test-writer": { removeCategories: ["file-write"] },
      },
    })
    expect(Object.keys(result.profiles)).toHaveLength(3)
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 4: PreferencesSchema — toolRouting integration
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-061: PreferencesSchema — toolRouting", () => {
  test("EC-061-21: toolRouting defaults to empty when preferences parsed from {}", () => {
    const result = PreferencesSchema.parse({})
    expect(result.toolRouting).toBeDefined()
    expect(result.toolRouting.globalDeny).toEqual([])
    expect(result.toolRouting.profiles).toEqual({})
  })

  test("EC-061-22: toolRouting preserved through full config round-trip", () => {
    const input = {
      toolRouting: {
        globalDeny: ["bash"],
        profiles: {
          reviewer: { addCategories: ["execution" as const] },
        },
      },
    }
    const result = PreferencesSchema.parse(input)
    expect(result.toolRouting.globalDeny).toEqual(["bash"])
    expect(result.toolRouting.profiles.reviewer?.addCategories).toEqual(["execution"])
  })
})

// ═══════════════════════════════════════════════════════════════════
// SECTION 5: ConfigFileSchema — Full integration
// ═══════════════════════════════════════════════════════════════════

test.describe("EC-061: ConfigFileSchema", () => {
  test("EC-061-23: parses empty object with all defaults", () => {
    const result = ConfigFileSchema.parse({})
    expect(result.preferences).toBeDefined()
    expect(result.preferences.maxSubagentIterations).toBe(3)
    expect(result.preferences.toolRouting).toBeDefined()
    expect(result.recentFolders).toEqual([])
    expect(result.opencodeBinaries).toEqual([])
  })

  test("EC-061-24: preserves all preference fields", () => {
    const result = ConfigFileSchema.parse({
      preferences: {
        maxSubagentIterations: 7,
        showThinkingBlocks: true,
        toolRouting: {
          globalDeny: ["webfetch"],
          profiles: {},
        },
      },
    })
    expect(result.preferences.maxSubagentIterations).toBe(7)
    expect(result.preferences.showThinkingBlocks).toBe(true)
    expect(result.preferences.toolRouting.globalDeny).toEqual(["webfetch"])
  })
})
