// Imported first: preferences load their owners as soon as their module is evaluated.
import { serverApi } from "../../../src/lib/api-client"

const now = Date.now()
export const recentFolders = [
  { path: "D:/CodeNomad", lastAccessed: now - 60_000 },
  { path: "D:/unsloth", lastAccessed: now - 6 * 86_400_000 },
  { path: "D:/blender", lastAccessed: now - 7 * 86_400_000, projectName: "Blender tools" },
  ...Array.from({ length: 12 }, (_, i) => ({ path: `D:/archive/project-${i}`, lastAccessed: now - (8 + i) * 86_400_000 })),
]
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({ recentFolders }) as any
serverApi.patchStateOwner = async () => ({ recentFolders }) as any
