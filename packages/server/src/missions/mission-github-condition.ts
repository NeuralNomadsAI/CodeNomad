import { z } from "zod"

export const missionGithubKinds = ["github-notification", "github-security-alert", "github-pull-request", "github-issue"] as const
export type MissionGithubKind = typeof missionGithubKinds[number]
export const isMissionGithubKind = (kind: string): kind is MissionGithubKind => (missionGithubKinds as readonly string[]).includes(kind)
export const githubRepositorySchema = z.string().trim().max(140)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine(value => ![".", ".."].includes(value.split("/")[1])).transform(value => value.toLowerCase())
export const githubAuthorSchema = z.string().trim().max(100).regex(/^@?[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/)
  .transform(value => value.replace(/^@/, "").toLowerCase())
export const missionGithubConditions = [
  z.object({ kind: z.literal("github-notification"), repository: githubRepositorySchema.optional() }).strict(),
  z.object({ kind: z.literal("github-security-alert"), repository: githubRepositorySchema }).strict(),
  z.object({ kind: z.literal("github-pull-request"), repository: githubRepositorySchema, author: githubAuthorSchema.optional() }).strict(),
  z.object({ kind: z.literal("github-issue"), repository: githubRepositorySchema, author: githubAuthorSchema.optional() }).strict(),
] as const
export const missionGithubConditionSchema = z.discriminatedUnion("kind", missionGithubConditions)
export type MissionGithubCondition = z.infer<typeof missionGithubConditionSchema>
export const isMissionGithubCondition = (value: { kind: string }): value is MissionGithubCondition => isMissionGithubKind(value.kind)

const timestamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString())
const identifier = z.string().min(1).max(240).regex(/^\d+$/)
const event = z.object({ id: identifier, at: timestamp, title: z.string().min(1).max(240),
  url: z.string().url().max(2048).refine(value => {
    const url = new URL(value)
    return ["https://github.com", "https://api.github.com"].includes(url.origin)
      && !url.username && !url.password && !url.search && !url.hash
  }), repository: githubRepositorySchema, author: z.string().max(100).optional() }).strict()
export const missionGithubCheckpointSchema = z.object({ at: timestamp, ids: z.array(identifier).max(200),
  events: z.array(event).max(200) }).strict()
export type MissionGithubEvent = z.infer<typeof event>
