import { authorizedImageUri, isRestrictedMedia, type MediaPolicy } from "./media-policy"
import { CODENOMAD_API_BASE } from "./api-base"
import { tGlobal } from "./i18n"

export const RAW_HTML_TAGS = new Set([
  "a", "blockquote", "br", "code", "del", "details", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "kbd", "li", "ol", "p", "pre", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "ul",
])
const generatedTags = new Set([
  ...RAW_HTML_TAGS, "button", "svg", "g", "path", "rect", "line", "circle", "ellipse", "polygon", "polyline",
  "math", "semantics", "annotation", "mrow", "mi", "mo", "mn", "mtext", "mspace", "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mover", "munder", "munderover", "mtable", "mtr", "mtd", "menclose", "mpadded", "mstyle", "mmultiscripts", "mprescripts", "none",
])
export const DROP_HTML_TAGS = new Set(["script", "style", "iframe", "object", "embed", "meta", "link", "audio", "video", "source", "track", "picture", "base", "form", "input", "textarea", "select", "option", "foreignobject", "image", "use", "template"])
const generatedAttributes = new Set([
  "type", "disabled", "tabindex", "viewbox", "xmlns", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "points", "preserveaspectratio", "focusable",
  "encoding", "display", "mathvariant", "stretchy", "fence", "separator", "accent", "accentunder", "columnalign", "rowspacing", "columnspacing", "linethickness", "minsize", "maxsize", "lspace", "rspace", "scriptlevel", "displaystyle", "notation", "colspan", "rowspan", "dir", "role",
])
// Generated Shiki/KaTeX layout only: none of these CSS properties can load resources.
const generatedStyles = new Set(["color", "background-color", "font-style", "font-weight", "font-size", "font-family", "line-height", "height", "width", "min-width", "max-width", "top", "bottom", "left", "right", "margin-left", "margin-right", "margin-top", "margin-bottom", "padding-left", "padding-right", "padding-top", "padding-bottom", "border-bottom-width", "border-top-width", "border-right-width", "border-left-width", "border-color", "border-style", "vertical-align", "position", "display", "text-align", "white-space", "transform", "transform-origin"])

export function safeMarkdownLink(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") && !url.username && !url.password
  } catch { return value.startsWith("#") }
}

/** Mandatory pre-publication filter. Template contents stay inert; rendered HTML is never entity-decoded. */
export function sanitizeRenderedMarkdown(html: string, policy: MediaPolicy): string {
  if (!isRestrictedMedia(policy)) return html
  if (typeof document === "undefined") return ""
  const template = document.createElement("template")
  template.innerHTML = html
  for (const element of [...template.content.querySelectorAll("*")].reverse()) {
    const tag = element.tagName.toLowerCase()
    if (DROP_HTML_TAGS.has(tag)) { element.remove(); continue }
    if (!generatedTags.has(tag)) { element.replaceWith(...element.childNodes); continue }
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase()
      if (name === "src" && tag === "img") {
        const source = authorizedImageUri(attr.value, policy, CODENOMAD_API_BASE)
        if (source) element.setAttribute("src", source)
        else element.removeAttribute(attr.name)
      } else if (name === "href" && tag === "a" && safeMarkdownLink(attr.value)) {
        element.setAttribute("target", "_blank")
        element.setAttribute("rel", "noopener noreferrer")
      } else if (name === "style") {
        const style = (element as HTMLElement).style
        if (!style || /[\\@]|url|expression|var\s*\(/i.test(attr.value)) element.removeAttribute(attr.name)
        else {
          for (const property of [...style]) if (!generatedStyles.has(property)) style.removeProperty(property)
          if (!style.length) element.removeAttribute(attr.name)
        }
      } else if (name === "alt" || name === "title" || name === "width" || name === "height" || name === "open" || name === "id" || name === "class" || name === "name" || name.startsWith("aria-") || name.startsWith("data-") || generatedAttributes.has(name)) {
        // SVG paint values can otherwise reference a URL even without a style attribute.
        if ((name === "fill" || name === "stroke") && !/^(?:none|currentColor|#[a-f0-9]{3,8})$/i.test(attr.value)) element.removeAttribute(attr.name)
      } else element.removeAttribute(attr.name)
    }
    if (tag === "a") {
      element.setAttribute("target", "_blank")
      element.setAttribute("rel", "noopener noreferrer")
    }
    if (element.hasAttribute("data-media-unavailable")) element.textContent = tGlobal("toolCall.image.unavailable")
    if (tag === "img") {
      if (!element.hasAttribute("src")) {
        const label = document.createElement("span")
        label.setAttribute("role", "status")
        label.setAttribute("data-media-unavailable", "")
        label.textContent = tGlobal("toolCall.image.unavailable")
        element.replaceWith(label)
      } else {
        element.setAttribute("loading", "lazy")
        element.setAttribute("referrerpolicy", "no-referrer")
      }
    }
  }
  // A bounded window can end inside image syntax. Its plain-text fallback must
  // keep the payload out of view while the complete native source stays intact.
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.parentElement?.closest("pre,code")) continue
    node.data = node.data.replace(/!\[[^\]\n]*\]\(\s*(?:data:|https?:|\/\/)[^\s)]*(?:\)|$)/gi, tGlobal("toolCall.image.unavailable"))
      .replace(/<(?:img|source|audio|video|iframe|object|embed|picture)\b[^>]*(?:>|$)/gi, tGlobal("toolCall.image.unavailable"))
  }
  return template.innerHTML
}
