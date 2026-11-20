import assert from "node:assert/strict"
import test from "node:test"
import { pcmWav } from "./hex-capture"

test("Hex renders bounded mono PCM WAV headers and signed little-endian samples", () => {
  const wav = Buffer.from(pcmWav(new Float32Array([-2, -0.5, 0, 0.5, 2])))
  assert.equal(wav.toString("ascii", 0, 4), "RIFF")
  assert.equal(wav.readUInt32LE(4), wav.length - 8)
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ")
  assert.equal(wav.readUInt16LE(20), 1)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(24), 16_000)
  assert.equal(wav.readUInt32LE(28), 32_000)
  assert.equal(wav.toString("ascii", 36, 40), "data")
  assert.equal(wav.readUInt32LE(40), 10)
  assert.deepEqual([44, 46, 48, 50, 52].map(offset => wav.readInt16LE(offset)), [-32768, -16384, 0, 16383, 32767])
})
