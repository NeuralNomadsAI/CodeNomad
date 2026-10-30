// The Design agent and skills are native OpenCode files under `opencode/`, copied unchanged for use
// without CodeNomad. Plugin bundles embed them as text (`.md` loader of the native plugin build), so the
// installed bundle carries them and their licence notices without any checkout path.

export const DESIGN_CONTENT_VERSION = 1
export const DESIGN_CONTENT_MARK = `codenomad-design-content: ${DESIGN_CONTENT_VERSION}`
export const DESIGN_AGENT_ID = "design"
export const DESIGN_SKILL_IDS = [
  "design-core", "design-app-icon", "design-logo", "design-illustration", "design-ui-mockup", "design-banner", "design-free",
] as const
export const DESIGN_DIRECTION_IDS = ["minimal", "friendly", "technical", "editorial", "bold"] as const
export const DESIGN_RECIPE_IDS = ["app-icon", "logo", "illustration", "ui-mockup", "banner", "free"] as const

export type DesignSkillID = (typeof DESIGN_SKILL_IDS)[number]

/** Raw file texts, notices included. */
export interface DesignSources {
  readonly agent: string
  readonly skills: Readonly<Record<DesignSkillID, string>>
  readonly notice: string
  readonly apacheLicense: string
}

export interface DesignAgentContent {
  readonly id: typeof DESIGN_AGENT_ID
  readonly name: "Design"
  readonly description: string
  readonly mode: "primary"
  /** Starts with `DESIGN_CONTENT_MARK`. */
  readonly system: string
}

export interface DesignSkillContent {
  readonly id: DesignSkillID
  readonly name: string
  readonly description: string
  readonly autoinvoke: false
  readonly content: string
}

export interface DesignContent {
  readonly version: typeof DESIGN_CONTENT_VERSION
  readonly agent: DesignAgentContent
  readonly skills: readonly DesignSkillContent[]
  readonly notices: { readonly notice: string; readonly apacheLicense: string }
}

/** Paths relative to this module, for checks that read the checkout. */
export const DESIGN_SOURCE_FILES = {
  agent: "opencode/agents/design.md",
  skill: (id: DesignSkillID) => `opencode/skills/${id}/SKILL.md`,
  notice: "opencode/NOTICE.md",
  apacheLicense: "opencode/LICENSE-APACHE-2.0.txt",
} as const

let embedded: Promise<DesignContent> | undefined

/** The content embedded in the running bundle. Only esbuild-built bundles can load it. */
export function loadDesignContent(): Promise<DesignContent> {
  // Literal specifiers let esbuild inline every file; nothing is read from disk at runtime.
  embedded ??= Promise.all([
    import("./opencode/agents/design.md"),
    import("./opencode/skills/design-core/SKILL.md"),
    import("./opencode/skills/design-app-icon/SKILL.md"),
    import("./opencode/skills/design-logo/SKILL.md"),
    import("./opencode/skills/design-illustration/SKILL.md"),
    import("./opencode/skills/design-ui-mockup/SKILL.md"),
    import("./opencode/skills/design-banner/SKILL.md"),
    import("./opencode/skills/design-free/SKILL.md"),
    import("./opencode/NOTICE.md"),
    import("./opencode/LICENSE-APACHE-2.0.txt"),
  ]).then(([agent, core, appIcon, logo, illustration, uiMockup, banner, free, notice, apacheLicense]) => parseDesignContent({
    agent: agent.default,
    skills: {
      "design-core": core.default, "design-app-icon": appIcon.default, "design-logo": logo.default,
      "design-illustration": illustration.default, "design-ui-mockup": uiMockup.default,
      "design-banner": banner.default, "design-free": free.default,
    },
    notice: notice.default,
    apacheLicense: apacheLicense.default,
  })).catch((error: unknown) => {
    embedded = undefined
    throw error
  })
  return embedded
}

/** Parses the native files strictly: a field OpenCode would read differently is an error, never ignored. */
export function parseDesignContent(sources: DesignSources): DesignContent {
  const agent = parseNativeFile(DESIGN_SOURCE_FILES.agent, sources.agent, ["description", "mode"])
  if (agent.data.mode !== "primary") throw new Error(`${DESIGN_SOURCE_FILES.agent}: mode must be primary`)
  if (!agent.body.startsWith(`${DESIGN_CONTENT_MARK}\n`)) throw new Error(`${DESIGN_SOURCE_FILES.agent}: system prompt must start with ${DESIGN_CONTENT_MARK}`)
  const skills = DESIGN_SKILL_IDS.map((id): DesignSkillContent => {
    const file = DESIGN_SOURCE_FILES.skill(id)
    const skill = parseNativeFile(file, sources.skills[id], ["name", "description"])
    if (skill.metadata["opencode/autoinvoke"] !== "false") throw new Error(`${file}: metadata opencode/autoinvoke must be false`)
    return { id, name: required(file, skill.data, "name"), description: required(file, skill.data, "description"), autoinvoke: false, content: skill.body }
  })
  return {
    version: DESIGN_CONTENT_VERSION,
    agent: { id: DESIGN_AGENT_ID, name: "Design", description: required(DESIGN_SOURCE_FILES.agent, agent.data, "description"), mode: "primary", system: agent.body },
    skills,
    notices: { notice: sources.notice, apacheLicense: sources.apacheLicense },
  }
}

interface NativeFile {
  readonly data: Record<string, string>
  readonly metadata: Record<string, string>
  readonly body: string
}

// The files use a small YAML subset: comments, `key: value` scalars (plain or JSON-compatible double
// quotes) and one nested `metadata:` map. Tests compare the result with a full YAML parser.
function parseNativeFile(file: string, source: string, keys: readonly string[]): NativeFile {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source.replace(/\r\n?/g, "\n"))
  if (!match) throw new Error(`${file}: missing frontmatter`)
  const data: Record<string, string> = {}
  const metadata: Record<string, string> = {}
  let nested: Record<string, string> | undefined
  for (const line of match[1].split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const entry = /^( *)([\w/-]+):(?: (.+))?$/.exec(line)
    if (!entry) throw new Error(`${file}: unsupported frontmatter line ${JSON.stringify(line)}`)
    const [, indent, key, raw] = entry
    if (indent) {
      if (!nested || raw === undefined) throw new Error(`${file}: unexpected nested ${key}`)
      nested[key] = scalar(raw)
      continue
    }
    if (raw === undefined) {
      if (key !== "metadata") throw new Error(`${file}: unsupported map ${key}`)
      nested = metadata
      continue
    }
    if (!keys.includes(key)) throw new Error(`${file}: unsupported field ${key}`)
    nested = undefined
    data[key] = scalar(raw)
  }
  return { data, metadata, body: match[2].trim() }
}

function scalar(raw: string): string {
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw
}

function required(file: string, data: Record<string, string>, key: string): string {
  const value = data[key]
  if (!value) throw new Error(`${file}: missing ${key}`)
  return value
}
