import { z } from "zod"

const entry = z.object({ directory: z.string().min(1).max(4096), physical: z.string().min(1).max(4096),
  dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^[1-9]\d*$/), birth: z.string().regex(/^\d+$/) }).strict()
export const missionCalendarPlacementSchema = z.object({ rootsDigest: z.string().regex(/^[a-f0-9]{64}$/), roots: z.array(entry).min(1).max(128),
  routing: z.array(z.object({ file: z.string().min(1).max(4096), digest: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()).max(128),
  gitEnvironmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
