import { mkdir, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"

const root = "C:/Users/Admin/AppData/Local/Temp/opencode/missions-desktop-trial-20261003"
const project = path.join(root, "product-project")
await mkdir(project)
await writeFile(path.join(project, "README.md"), "# Short product Mission trial\nNo source or user configuration modifications are permitted.\n")
const git = args => execFileSync("git", ["-C", project, ...args], { windowsHide: true, stdio: "pipe" })
git(["init", "--quiet"])
git(["add", "README.md"])
git(["-c", "user.name=CodeNomad Trial", "-c", "user.email=trial@invalid.example", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "test: seed private product trial identity"])
await writeFile(path.join(project, "opencode.json"), JSON.stringify({
  model: "openai/gpt-6.1-sol", default_agent: "mission_trial", snapshots: false,
  experimental: { subagent_depth: 3 },
  permissions: [{ action: "*", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "allow" },
    { action: "mission_*", resource: "*", effect: "allow" }],
  agents: { mission_trial: { mode: "all", model: "openai/gpt-6.1-sol", steps: 14,
    description: "Short recursive product Mission on GPT-6.1 Sol",
    system: "Use native recursive subagents on GPT-6.1 Sol. The root uses Missions to track its plan and business completion; descendants return through native hierarchy only, no mission_report copies. No shell/files/network tools or other side effects. Use mission_trial for child and grandchild." } },
}, null, 2))
console.log(JSON.stringify({ root, project, localPluginOverride: false }))
