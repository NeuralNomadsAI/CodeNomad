import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { Marked } from "marked"

const root = fileURLToPath(new URL("../", import.meta.url))
const source = resolve(root, "docs/help")
const output = resolve(process.argv[2] ?? resolve(root, "dist/help"))
const pages = [
  ["index", "Overview"],
  ["getting-started", "Connect OpenCode"],
  ["conversations", "Conversations"],
  ["projects", "Projects and worktrees"],
  ["files-and-tools", "Files and tools"],
  ["settings", "Settings"],
  ["troubleshooting", "Troubleshooting"],
]
const repo = "https://github.com/NeuralNomadsAI/CodeNomad"
const escape = (value) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])

await mkdir(resolve(output, "assets"), { recursive: true })
await Promise.all([
  cp(resolve(source, "help.css"), resolve(output, "assets/help.css")),
  cp(resolve(root, "docs/screenshots/workspace-0.20.png"), resolve(output, "assets/workspace.png")),
  cp(resolve(root, "images/CodeNomad-Icon.png"), resolve(output, "assets/logo.png")),
  writeFile(resolve(output, ".nojekyll"), ""),
])

for (const [name, label] of pages) {
  const headings = []
  const used = new Map()
  const markdown = new Marked({ renderer: {
    heading(text, level, raw) {
      const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      const count = used.get(slug) ?? 0
      used.set(slug, count + 1)
      const id = count ? `${slug}-${count}` : slug
      if (level === 2) headings.push({ text: raw, id })
      return `<h${level} id="${id}">${text}</h${level}>\n`
    },
    link(href, title, text) {
      const target = href.replace(/^([\w-]+)\.md(?=#|$)/, "$1.html")
      return `<a href="${escape(target)}"${title ? ` title="${escape(title)}"` : ""}>${text}</a>`
    },
    image(href, title, text) {
      const target = href === "../screenshots/workspace-0.20.png" ? "assets/workspace.png" : href
      return `<img src="${escape(target)}" alt="${escape(text)}"${title ? ` title="${escape(title)}"` : ""}>`
    },
  } })
  const content = markdown.parse(await readFile(resolve(source, `${name}.md`), "utf8"))
  const nav = pages.map(([id, title]) => `<a href="${id}.html"${id === name ? ' aria-current="page"' : ""}>${title}</a>`).join("\n")
  const toc = headings.map(({ text, id }) => `<li><a href="#${id}">${escape(text)}</a></li>`).join("\n")
  await writeFile(resolve(output, `${name}.html`), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escape(`CodeNomad help: ${label}. A short guide to the current OpenCode V2 workspace.`)}">
  <meta name="color-scheme" content="light dark">
  <title>${label} — CodeNomad help</title>
  <link rel="icon" href="assets/logo.png">
  <link rel="stylesheet" href="assets/help.css">
</head>
<body>
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="index.html"><img src="assets/logo.png" alt="" width="36" height="36">CodeNomad <span>Help</span></a>
    <nav aria-label="Project links"><a href="${repo}/releases/latest">Download</a><a href="${repo}">GitHub</a></nav>
  </header>
  <div class="layout">
    <aside class="sidebar"><p class="eyebrow">User guide</p><nav aria-label="Help topics">${nav}</nav><p class="scope">Current CodeNomad<br> OpenCode V2 · English</p></aside>
    <main id="content" tabindex="-1"><article>${content}</article><footer><a href="${repo}/blob/dev/docs/help/${name}.md">Edit this page</a><a href="${repo}/issues">Report a problem</a></footer></main>
    <aside class="outline"><details open><summary>On this page</summary><ul>${toc}</ul></details><p>Find text with<br><kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>F</kbd></p></aside>
  </div>
</body>
</html>
`)
}
console.log(`Built ${pages.length} help pages in ${output}`)
