import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export const serviceHelp = `DESCRIPTION
  Manage the background server
USAGE
  opencode2 service <subcommand> [flags]
SUBCOMMANDS
  start      Start the background server
  status     Show background server status
  get        Get service configuration
`

export const legacyHelp = `Commands:
  opencode completion          generate shell completion script
  opencode [project]           start opencode tui [default]
  opencode attach <url>        attach to a running opencode server
`

// Actual subprocess fixture: exercises host shell/shim quoting and never starts
// a real daemon or reads user configuration. Every invocation is recorded.
export function binaryProbeFixture(options: {
  help?: string
  delayMs?: number
  helpExit?: number
  stderr?: boolean
} = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "codenomad-binary-é ' space-"))
  const script = path.join(directory, "probe.cjs")
  const log = path.join(directory, "calls.jsonl")
  const binary = path.join(directory, process.platform === "win32" ? "opencode.cmd" : "opencode")
  writeFileSync(script, `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
    setTimeout(() => {
      const version = args.join(' ') === '--version';
      if (!version && args.join(' ') !== 'service --help') process.exit(99);
      process[${JSON.stringify(options.stderr ? "stderr" : "stdout")}].write(version ? 'custom-build\\n' : ${JSON.stringify(options.help ?? serviceHelp)});
      process.exitCode = version ? 0 : ${options.helpExit ?? 0};
    }, ${options.delayMs ?? 0});
  `)
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
  writeFileSync(binary, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "%~dp0probe.cjs" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 })
  return {
    binary,
    calls: (): string[][] => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}
