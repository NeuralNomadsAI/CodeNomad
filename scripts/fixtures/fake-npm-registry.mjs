// Loopback fake npm registry for native fixtures (dev-docs/BROWSER_TESTING.md, Native fixtures): serves the
// packuments and tarballs published to it and answers 404 for every other name. Pass `url` as the `registry`
// option of withProductRuntime so the daemon's package installs never reach the public registry.
import { createHash } from "node:crypto"
import { createServer } from "node:http"

export async function startFakeNpmRegistry() {
  const packages = new Map(), tarballs = new Map(), requested = []
  let url
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(req.url.split("?")[0])
    requested.push(pathname)
    const archive = tarballs.get(pathname)
    if (archive) { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(archive); return }
    const versions = packages.get(pathname.slice(1))
    if (!versions) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"Not found"}'); return }
    const name = pathname.slice(1)
    const latest = [...versions.keys()].at(-1)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ name, "dist-tags": { latest }, versions: Object.fromEntries([...versions].map(([version, dist]) =>
      [version, { name, version, dist }])) }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  url = `http://127.0.0.1:${server.address().port}`
  return {
    url, requested,
    /** Serves `tarball` as `name@version`; the last published version is `latest`. */
    publish(name, version, tarball) {
      const file = `/${name}/-/${name.split("/").at(-1)}-${version}.tgz`
      tarballs.set(file, tarball)
      if (!packages.has(name)) packages.set(name, new Map())
      packages.get(name).set(version, { tarball: `${url}${file}`, shasum: createHash("sha1").update(tarball).digest("hex"),
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` })
    },
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
