import type { DeviceSpeechError } from "./contract"
export class HexFailure extends Error {
  constructor(code?: DeviceSpeechError)
  readonly code: DeviceSpeechError
}
