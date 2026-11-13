import { z } from "zod"

export const repositoryEvents = ["pull-request-created", "pull-request-merged", "issue-created"] as const
export const repositoryIdentitySchema = z.object({
  provider: z.enum(["github", "gitlab", "gitea"]),
  host: z.string().max(253).refine(value => {
    try { const url = new URL(`https://${value}`); return url.host === value && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash }
    catch { return false }
  }),
  repository: z.string().min(3).max(1024).refine(value => value.split("/").length >= 2
    && value.split("/").every(part => /^[A-Za-z0-9_.-]+$/.test(part) && !/^\.+$/.test(part))),
})
export const repositoryAuthorSchema = z.string().trim().max(100).regex(/^@?[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\[bot\])?$/)
  .transform(value => value.replace(/^@/, "").toLowerCase())
export const missionRepositoryConditionSchema = repositoryIdentitySchema.extend({ kind: z.literal("repository-activity"),
  event: z.enum(repositoryEvents), author: repositoryAuthorSchema.optional() }).strict()
export type MissionRepositoryCondition = z.infer<typeof missionRepositoryConditionSchema>
export type MissionRepositoryIdentity = z.infer<typeof repositoryIdentitySchema>
const timestamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString())
export const repositoryEventSchema = z.object({ id: z.string().regex(/^\d+$/).max(240), at: timestamp,
  title: z.string().min(1).max(240), url: z.string().url().max(2048), repository: repositoryIdentitySchema.shape.repository,
  author: z.string().max(100).optional() }).strict()
export const missionRepositoryCheckpointSchema = z.object({ at: timestamp, ids: z.array(z.string().regex(/^\d+$/)).max(200),
  events: z.array(repositoryEventSchema).max(200) }).strict()
