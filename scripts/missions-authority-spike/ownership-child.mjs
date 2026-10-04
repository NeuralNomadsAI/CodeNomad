import { claimFamily } from "./family-ownership.mjs"

const [directory, family, profileID, mode] = process.argv.slice(2)
let claim
try {
  claim = await claimFamily(directory, family, profileID)
  console.log(JSON.stringify({ acquired: true, pid: process.pid }))
  if (mode === "hold") {
    process.stdin.resume()
    await new Promise(resolve => process.stdin.once("end", resolve))
  }
} catch (error) {
  console.log(JSON.stringify({ acquired: false, error: error.message }))
} finally { await claim?.release() }
