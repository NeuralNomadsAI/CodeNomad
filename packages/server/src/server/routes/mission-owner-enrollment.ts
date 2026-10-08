import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { constants } from "node:fs"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { mkdir, open, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import { runtimeIdentity } from "../../opencode/compatibility/runtime"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { assertLoopbackServiceUrl } from "../../workspaces/service-state"
import { physical, verifyPrivateSync } from "../../missions/host-authority/private-files"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { enrollmentSchema, assertNativeManagedOwnerReadback } from "../../opencode/missions/native-managed-owner"
import { MANAGED_OWNER_RPC_ID } from "../../opencode/missions/managed-owner-plugin"
import { requestAdmission } from "../request-admission"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

/** A deliberate authenticated POST with no caller-supplied descriptor or path.
 * The descriptor is only an enrollment receipt; it never mints a namespace,
 * storage ID, signer or recurrence authority. Existing receipts are not replaced. */
export function registerMissionOwnerEnrollment(app: FastifyInstance, deps: {
  manager: EnrollmentManager
  privateRoot: string
  fence?: WorktreeDeletionFence
}) {
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/missions/managed-owner/enroll", async (request, reply) => {
    const lifetime = requestAdmission(request, reply)
    let release: (() => void) | undefined
    try {
      if (request.body !== undefined && canonicalAuthority(request.body) !== "{}") return reply.code(400).send({ error: "Enrollment accepts no descriptor" })
      const id = request.params.id
      if (typeof id !== "string" || !id || id.length > 200) return reply.code(400).send({ error: "Invalid workspace" })
      const workspace = deps.manager.get(id), location = deps.manager.getServiceLocation(id)
      if (!workspace || !location || "workspaceID" in location) return reply.code(404).send({ error: "Workspace unavailable" })
      const root = location.directory, host = await lifetime.wait(deps.manager.getHostPathForServicePath(id, root))
      if (!host) throw new Error("Physical root unavailable")
      const physicalHost = physical(realpathSync(host))
      if (deps.fence && !(release = deps.fence.enter([physicalHost]))) throw new Error("Worktree deletion in progress")
      const connection = await lifetime.wait(deps.manager.getSharedServiceConnection(id))
      if (!connection || !await lifetime.wait(deps.manager.ownsLocation(id, { directory: root }, connection.client))) throw new Error("Location ownership unavailable")
      const native = runtimeIdentity(connection.endpoint)
      if (!native || native.pid < 1) throw new Error("Authenticated service identity unavailable")
      const options = { location: { directory: root }, ...locationRequestOptions(location), signal: lifetime.signal }
      const [resolved, inventory, sources] = await lifetime.wait(Promise.all([
        connection.client.location.get({ location: { directory: root } }, options),
        connection.client.plugin.list({ location: { directory: root } }, options),
        connection.client.config.get({ location: { directory: root } }, options),
      ]))
      if (!sameLocation(location, resolved) || !await lifetime.wait(deps.manager.ownsLocation(id, resolved, connection.client, lifetime.signal))) throw new Error("Registered Location changed")
      const placement = await lifetime.wait(resolveEnrollmentPlacement(deps.manager, id, root, resolved.project.canonical))
      if (placement.host !== physicalHost) throw new Error("Physical Location changed")
      const global = sources.find(item => item.type === "directory")?.path
      const wsl = Boolean(deps.manager.getServiceWslDistro(id))
      const nativePaths = wsl ? path.posix : path
      const entryService = global && nativePaths.join(global, "plugins", "codenomad-missions.ts")
      const entry = entryService && await lifetime.wait(deps.manager.getHostPathForServicePath(id, entryService))
      const plugin = inventory.data.find(item => item.id === "codenomad.missions")
      if (!entry || !entryService || plugin?.state.status !== "active" || plugin.source.type !== "local"
        || (wsl ? path.posix.normalize(plugin.source.path) !== entryService : physical(plugin.source.path) !== physical(entry))) throw new Error("Managed bundle unavailable")
      const source = await lifetime.wait(readFile(entry, "utf8"))
      const match = /^\/\/ Managed by CodeNomad: missions lifecycle v1\nimport \{ desktopPlugin \} from ("(?:[^"\\]|\\.)*")\nexport default desktopPlugin\(.+\)\n$/.exec(source)
      if (!match) throw new Error("Managed bundle entry unavailable")
      const url = new URL(JSON.parse(match[1]) as string)
      if (url.protocol !== "file:" || url.search || url.hash || url.host) throw new Error("Managed bundle URL unavailable")
      const bundleService = wsl ? decodeURIComponent(url.pathname) : fileURLToPath(url)
      if (!/^[a-f0-9]{64}\.mjs$/.test(nativePaths.basename(bundleService)) || nativePaths.basename(nativePaths.dirname(bundleService)) !== "missions") throw new Error("Managed bundle path unavailable")
      const bundle = await lifetime.wait(deps.manager.getHostPathForServicePath(id, bundleService))
      if (!bundle) throw new Error("Managed bundle host path unavailable")
      const named = await stat(bundle)
      if (!named.isFile() || named.size > 32 * 1024 * 1024 || lstatSync(bundle).isSymbolicLink()
        || createHash("sha256").update(await readFile(bundle)).digest("hex") !== nativePaths.basename(bundleService, ".mjs")) throw new Error("Managed bundle bytes changed")
      const response = await lifetime.wait(connection.client.rpc.call({ rpcID: MANAGED_OWNER_RPC_ID, method: "observe", input: {},
        location: { directory: root } }, { signal: lifetime.signal }))
      const observed = response.output as Record<string, unknown>
      const enrollment = enrollmentSchema.parse(observed?.enrollment)
      if (observed.projectID !== resolved.project.id || observed.projectCanonical !== resolved.project.canonical
        || observed.directory !== root || observed.storageChallengeVerified !== true
        || enrollment.service.pid !== native.pid || enrollment.service.version !== native.version
        || assertLoopbackServiceUrl(enrollment.service.url).origin !== assertLoopbackServiceUrl(connection.endpoint.url).origin) throw new Error("Managed service observation changed")
      // Re-observe immediately before publication; a stale or ambiguous service
      // cannot be enrolled by copying a prior RPC response or a moved checkout.
      const fresh = await lifetime.wait(connection.client.rpc.call({ rpcID: MANAGED_OWNER_RPC_ID, method: "observe", input: {},
        location: { directory: root } }, { signal: lifetime.signal }))
      if (canonicalAuthority(fresh.output) !== canonicalAuthority(response.output)) throw new Error("Managed service observation changed")
      if (canonicalAuthority(await lifetime.wait(resolveEnrollmentPlacement(deps.manager, id, root, resolved.project.canonical))) !== canonicalAuthority(placement)) throw new Error("Physical project family changed")
      const current = () => {
        lifetime.signal.throwIfAborted(); connection.assertCurrent()
        if (deps.manager.get(id) !== workspace || deps.manager.getServiceLocation(id)?.directory !== root
          || physical(realpathSync(host)) !== placement.host || physical(realpathSync(placement.canonicalHost)) !== placement.canonicalHost
          || physical(realpathSync(placement.checkout)) !== placement.checkout
          || readFileSync(entry, "utf8") !== source
          || createHash("sha256").update(readFileSync(bundle)).digest("hex") !== nativePaths.basename(bundleService, ".mjs")) throw new Error("Project root or managed bundle changed")
        // Linux daemon files/PIDs have Linux identities. Never compare their
        // inode/start-time with Windows translations; the two native observations
        // above supply that proof while this synchronous fence holds host paths.
        if (!wsl) assertNativeManagedOwnerReadback(enrollment)
        return true
      }
      const deletionCurrent = deps.fence?.captureDisplay([physicalHost])
      const directory = deps.privateRoot
      // The private root is a construction dependency from CodeNomad's profile,
      // never chosen by a browser or by the native RPC response.
      let created = false
      try { await mkdir(directory, { mode: 0o700 }); created = true }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
      if (created && process.platform === "win32") {
        // Native owner acquisition already requires this exact private DACL.
        // Only provision our newly created directory; never relax existing ACLs.
        const script = `$p='${directory.replaceAll("'", "''")}'; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[System.Security.AccessControl.DirectorySecurity]::new(); $a.SetOwner($u); $a.SetAccessRuleProtection($true,$false); foreach($s in @($u,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}; Set-Acl -LiteralPath $p -AclObject $a -ErrorAction Stop`
        execFileSync(path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
          { windowsHide: true, timeout: 5000, stdio: "pipe" })
      }
      verifyPrivateSync(directory, true)
      // One descriptor per native project and physical Git family, not one per
      // checkout alias: owned worktrees share the same managed service authority.
      const file = path.join(directory, `${createHash("sha256").update(`${resolved.project.id}\0${placement.family}`).digest("hex")}.json`)
      current(); if (deletionCurrent && !deletionCurrent()) throw new Error("Worktree deletion in progress")
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        current(); if (deletionCurrent && !deletionCurrent()) throw new Error("Worktree deletion in progress")
        await handle.writeFile(JSON.stringify(enrollment))
        await handle.sync()
        current(); if (deletionCurrent && !deletionCurrent()) throw new Error("Worktree deletion in progress")
        verifyPrivateSync(file, false)
        if (canonicalAuthority(JSON.parse(await readFile(file, "utf8"))) !== canonicalAuthority(enrollment)) throw new Error("Enrollment readback changed")
        if (canonicalAuthority(await lifetime.wait(resolveEnrollmentPlacement(deps.manager, id, root, resolved.project.canonical))) !== canonicalAuthority(placement)) throw new Error("Physical project family changed")
        if (wsl) {
          // Linux inode/PID evidence cannot be reinterpreted by the Windows
          // backend. Ask the sealed native graph to verify it after publication.
          const last = await lifetime.wait(connection.client.rpc.call({ rpcID: MANAGED_OWNER_RPC_ID, method: "observe", input: {},
            location: { directory: root } }, { signal: lifetime.signal }))
          if (canonicalAuthority(last.output) !== canonicalAuthority(response.output)) throw new Error("Managed service changed")
        }
        current(); if (deletionCurrent && !deletionCurrent()) throw new Error("Worktree deletion in progress")
      } finally { await handle.close() }
      return { enrolled: true }
    } catch {
      // Unknown effects leave the exclusive file untouched; no automatic replay,
      // removal or overwrite. Explicit offline reconciliation owns recovery.
      return reply.code(503).send({ error: "Managed owner enrollment unavailable or already recorded" })
    } finally { release?.(); lifetime.dispose() }
  })
}

type EnrollmentManager = Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection" | "getHostPathForServicePath"
  | "getServiceDirectoryForPath" | "getWorktreeIdentityForPath" | "getServiceWslDistro" | "ownsLocation">

/** All filesystem identities are host paths translated by the selected
 * workspace; never compare a Linux Location against a Windows host path. */
export async function resolveEnrollmentPlacement(manager: EnrollmentManager, id: string, root: string, canonical: string) {
  if (manager.getServiceLocation(id)?.directory !== root || await manager.getServiceDirectoryForPath(id, root) !== root) throw new Error("Registered Location changed")
  const [host, canonicalHost, checkout] = await Promise.all([
    manager.getHostPathForServicePath(id, root), manager.getHostPathForServicePath(id, canonical),
    manager.getWorktreeIdentityForPath(id, root),
  ])
  if (!host || !canonicalHost || !checkout) throw new Error("Physical project root unavailable")
  const [family, canonicalFamily, checkoutFamily] = await Promise.all([
    readFamilyAuthorityIdentity(host), readFamilyAuthorityIdentity(canonicalHost), readFamilyAuthorityIdentity(checkout),
  ])
  if (family !== canonicalFamily || family !== checkoutFamily) throw new Error("Physical project family changed")
  return { host: physical(realpathSync(host)), canonicalHost: physical(realpathSync(canonicalHost)),
    checkout: physical(realpathSync(checkout)), family }
}
