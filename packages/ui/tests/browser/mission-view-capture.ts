import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Page } from "playwright"

export async function captureMissionView(page: Page, name: string) {
  const directory = process.env.CODENOMAD_MISSION_VIEW_EVIDENCE
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true })
  await writeFile(join(directory, `${name}.json`), JSON.stringify(await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight }, direction: document.documentElement.dir,
    text: document.body.innerText,
  })), null, 2))
}
