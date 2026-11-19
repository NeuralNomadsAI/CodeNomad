import assert from "node:assert/strict"
import { test } from "node:test"
import { shellCommandLabel } from "./shell-command-label"

test("command labels unwrap only recognized envelopes and preserve every script argument", () => {
  const cases = [
    ["node script.js --flag", "node script.js", "--flag"],
    ['node "C:\\Build Tools\\watch.js" --port 3001', 'node "C:\\Build Tools\\watch.js"', "--port 3001"],
    ["npm run dev -- --port 3001", "npm run dev", "-- --port 3001"],
    ['pwsh -NoProfile -File "C:\\Build Tools\\watch.ps1" -Port 3001', "watch.ps1", "-Port 3001"],
    ['"C:\\Program Files\\PowerShell\\pwsh.exe" -File "C:\\Build Tools\\watch.ps1" -Port 3002', "watch.ps1", "-Port 3002"],
    ['cmd.exe /c node "C:\\Build Tools\\watch.js" --port 3001', 'node "C:\\Build Tools\\watch.js"', "--port 3001"],
    ["wsl.exe -e node /home/me/watch.js --port 3001", "node /home/me/watch.js", "--port 3001"],
    ["bash -lc 'node script.js --port 3001'", "node script.js", "--port 3001"],
    ["node script.js   --port 3002", "node script.js", "--port 3002"],
  ]
  for (const [command, program, args] of cases) assert.deepEqual(shellCommandLabel(command), { program, args }, command)
  assert.notDeepEqual(shellCommandLabel("node script.js --port 3001"), shellCommandLabel("node script.js --port 3002"))
})

test("ambiguous shell syntax stays raw", () => {
  for (const command of [
    "", 'cmd /s /c ""C:\\Build Tools\\watch.cmd" --port 3001"',
    'pwsh -Command "& {node script.js}"', "pwsh -EncodedCommand YQ==",
    "node a.js | cat", "node a.js && node b.js", "node a.js > output",
    "PORT=3001 node script.js", "node $(echo script.js)", "node `echo script.js`",
    "wsl.exe -d Ubuntu --cd /srv -e node script.js", "bash -lc \"node script.js\"",
    "pwsh -File -", "cmd /c node %SCRIPT% --port 3001", "cmd /c node ^script.js",
    "cmd /c node !SCRIPT!", "bash -lc 'node scripts/*.js'", "bash -lc 'node script.js # comment'",
    'node "unterminated', 'node "script".js', "unknown --flag", "cmd /c ".repeat(1000) + "node script.js",
  ]) assert.equal(shellCommandLabel(command), null, command)
})
