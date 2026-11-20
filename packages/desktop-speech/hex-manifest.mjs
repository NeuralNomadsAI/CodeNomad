// Release metadata: https://anoma.ly/release/hex/desktop/stable.json
// Model pins: anomalyco/hex v3.4.0, transcription/artifacts.rs and models.rs.
export const hexVersion = "3.4.0"
const release = (filename, bytes, sha256) => ({
  filename, bytes, sha256, license: "MIT",
  url: `https://anoma.ly/release/hex/files/${sha256}/${filename}`,
})
const engines = {
  "win32-x64": release("hex.exe", 87_241_648, "90bf9543dee8c3c799de95cbb4ccd1c05bcb29863c7212c1bd641979e287af9e"),
  "win32-arm64": release("hex.exe", 67_292_592, "9f31a38ced09e23d87d5a2e4977db3024de988275593f750f26ba6d8882b7a24"),
  "darwin-arm64": release("Hex.zip", 35_098_476, "1ab0242dc3bb011c88568903cbf1e9d30310867a46f5168309853d6f8b4ca650"),
  "linux-x64": release("hex", 90_638_008, "7f8132a2202338c1b52c36113d23d7403cf91f220bcdbd9eec82bc726f5f8029"),
  "linux-arm64": release("hex", 81_168_104, "bd549e896874c417b841cd8e1e724bbaca59046978e0ad2b7e72921de4101e0c"),
}
const model = (repository, revision, filename, bytes, sha256, license) => ({
  filename, bytes, sha256, license, repository, revision,
  url: `https://huggingface.co/handy-computer/${repository}/resolve/${revision}/${filename}`,
})
export const modelId = "parakeet_v3"
const parakeet = model("parakeet-tdt-0.6b-v3-gguf", "85ac09ea12fc4b1112fa76810059364bc6adc9de",
  "parakeet-tdt-0.6b-v3-Q8_0.gguf", 739_508_576, "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7", "CC-BY-4.0")
const silero = model("silero-vad-v6.2-gguf", "a9b2d61c20ae4ddf3644edb34969e8185a485448",
  "silero-vad-v6.2-F32.gguf", 1_241_056, "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6", "MIT")

export function hexArtifacts(platform, arch, release, glibc) {
  const engine = engines[`${platform}-${arch}`]
  if (!engine || (platform === "darwin" && Number(release.split(".")[0]) < 24)) return
  if (platform === "linux") {
    const [major, minor] = (glibc ?? "").split(".").map(Number)
    if (!(major > 2 || (major === 2 && minor >= 36))) return
  }
  return { engine, model: parakeet, vad: silero }
}
