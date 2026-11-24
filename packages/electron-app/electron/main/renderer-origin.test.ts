import assert from "node:assert/strict"
import test from "node:test"
import { resolveConfiguredRendererOrigins } from "./renderer-origin"

test("packaged renderer origins exclude development server environment URLs", () => {
  assert.deepEqual(
    resolveConfiguredRendererOrigins(
      "https://127.0.0.1:43123/workspace",
      true,
      ["http://localhost:3000/app", "http://127.0.0.1:5173/loading.html"],
    ),
    ["https://127.0.0.1:43123"],
  )
})

test("development renderer origins include configured development servers", () => {
  assert.deepEqual(
    resolveConfiguredRendererOrigins(
      "http://127.0.0.1:43123/workspace",
      false,
      ["http://localhost:3000/app", "http://localhost:3000/loading.html"],
    ),
    ["http://127.0.0.1:43123", "http://localhost:3000"],
  )
})
