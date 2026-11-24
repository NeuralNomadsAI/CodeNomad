import { z } from "zod"

export const sessionPermissionRules = z.array(z.object({
  action: z.string(),
  resource: z.string(),
  effect: z.enum(["allow", "ask", "deny"]),
}).strict())
