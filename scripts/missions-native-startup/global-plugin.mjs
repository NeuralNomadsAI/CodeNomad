import emit from "./emit.cjs"

emit.module("global-plugin-module", import.meta.url)
export default {
  id: "missions.native-startup-fixture",
  async setup(ctx) {
    emit("global-plugin-setup", ctx.location.directory)
    await ctx.storage.set(`missions-native-startup/${process.env.NATIVE_STARTUP_NONCE}`, {
      pid: process.pid, directory: ctx.location.directory,
    })
  },
}
