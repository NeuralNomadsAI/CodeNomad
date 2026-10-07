// Fixture-only cold entry: no HTTP, scheduler, agent execution or product imports.
import emit from "./emit.cjs"
emit("bun-preload")
