// electron-builder afterSign hook. It runs after electron-builder edits the
// Windows executable's resources, which happens even without a certificate.
//
// electron-builder writes the numeric Windows form of the version
// (major.minor.patch.0) as the ProductVersion string, while Tauri's binaries
// carry the full application version. SignPath Foundation requires every
// signed binary of a release to carry the same product version, so the string
// resource is set to the full version. The fixed VS_FIXEDFILEINFO fields only
// hold numbers and already match Tauri's (major.minor.patch.0).
const path = require("node:path")

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== "win32") return
  const { productFilename, version } = context.packager.appInfo
  const executable = path.join(context.appOutDir, `${productFilename}.exe`)
  if (process.platform !== "win32" && process.platform !== "darwin") {
    console.warn(`afterSign: cannot edit ${executable} resources on ${process.platform}; ProductVersion stays numeric`)
    return
  }
  // The same rcedit invocation electron-builder uses for its own edits.
  const builderUtil = require(require.resolve("builder-util", { paths: [require.resolve("app-builder-lib")] }))
  await builderUtil.executeAppBuilder(
    ["rcedit", "--args", JSON.stringify([executable, "--set-version-string", "ProductVersion", version])],
    undefined, {}, 3,
  )
}
