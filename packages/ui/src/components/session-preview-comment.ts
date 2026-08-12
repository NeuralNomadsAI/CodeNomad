import type { BrowserFrameElementTarget } from "./browser-frame"

function safeMetadata(value: string | undefined, maxLength: number): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f`]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength)
}

export function buildPreviewCommentMarkdown(target: BrowserFrameElementTarget, comment: string): string {
  const pagePath = safeMetadata(target.pagePath, 300)
  const tag = safeMetadata(target.tagName, 40) || "element"
  const label = safeMetadata(target.ariaLabel, 160) || safeMetadata(target.text, 160)
  const roleValue = safeMetadata(target.role, 80)
  const selector = safeMetadata(target.selector, 300)
  const role = roleValue ? ` role="${roleValue}"` : ""
  const element = label ? `${tag}${role} "${label}"` : `${tag}${role}`
  const lines = ["> Web preview comment", `> Page: \`${pagePath}\``, `> Element: \`${element}\``]
  if (selector) lines.push(`> Selector: \`${selector}\``)
  return `${lines.join("\n")}\n\n${comment}\n\n`
}
