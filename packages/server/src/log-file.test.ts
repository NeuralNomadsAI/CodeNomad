import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createLogger } from "./logger"
import { openLogFile, previousLogFile, serverLogFile } from "./log-file"

function scratch(context: { after(fn: () => void): void }): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codenomad-log-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test("a full log file moves aside and the next lines start a new one", (context) => {
  const file = serverLogFile(scratch(context))
  const log = openLogFile(file, 20)
  log.write("first line of text\n")
  log.write("second\n")
  assert.equal(readFileSync(file, "utf8"), "first line of text\nsecond\n")
  log.write("third\n")
  assert.equal(readFileSync(previousLogFile(file), "utf8"), "first line of text\nsecond\n")
  assert.equal(readFileSync(file, "utf8"), "third\n")
})

test("a restarted backend appends to the file it finds and counts its size", (context) => {
  const file = serverLogFile(scratch(context))
  openLogFile(file, 20).write("from the first run!\n")
  const log = openLogFile(file, 20)
  log.write("second run\n")
  assert.equal(readFileSync(previousLogFile(file), "utf8"), "from the first run!\n")
  assert.equal(readFileSync(file, "utf8"), "second run\n")
})

test("a log file that cannot be written never fails the caller", (context) => {
  const directory = scratch(context)
  // A file where the log directory should be.
  writeFileSync(path.join(directory, "logs"), "")
  const log = openLogFile(serverLogFile(directory))
  assert.doesNotThrow(() => { log.write("lost\n"); log.write("lost too\n") })
})

test("the file keeps the timestamped lines of every component, also those stdout omits", async (context) => {
  const file = serverLogFile(scratch(context))
  const logger = createLogger({ level: "info", destination: "stdout", file })
  // At info, stdout prints only the lifecycle components: this line reaches the file alone.
  logger.child({ component: "http" }).info({ workspaceId: "w1" }, "Mission plugin snapshot is unavailable")
  await new Promise(resolve => setImmediate(resolve))
  assert.match(readFileSync(file, "utf8"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] \[http\] Mission plugin snapshot is unavailable workspaceId=w1\n$/)
})
