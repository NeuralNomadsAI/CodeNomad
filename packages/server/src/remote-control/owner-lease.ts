import fs from "node:fs"
import path from "node:path"

/**
 * One backend per config directory resumes Remote Control at launch: OpenTunnel
 * gives a route to one bridge at a time and a contender retries until it takes
 * over, so a second backend would silently serve the paired devices.
 */
export class RemoteControlOwnerLease {
  constructor(
    private readonly filePath: string,
    private readonly pid = process.pid,
    private readonly isAlive: (pid: number) => boolean = isProcessAlive,
  ) {}

  /** Takes the lease unless another live backend holds it; stale leases are replaced. */
  tryAcquire(): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
        fs.writeFileSync(this.filePath, String(this.pid), { flag: "wx", mode: 0o600 })
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false
      }
      const owner = this.owner()
      if (owner === this.pid) return true
      if (owner !== null && this.isAlive(owner)) return false
      fs.rmSync(this.filePath, { force: true })
    }
    return false
  }

  release(): void {
    if (this.owner() === this.pid) fs.rmSync(this.filePath, { force: true })
  }

  private owner(): number | null {
    try {
      const pid = Number(fs.readFileSync(this.filePath, "utf8").trim())
      return Number.isInteger(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
