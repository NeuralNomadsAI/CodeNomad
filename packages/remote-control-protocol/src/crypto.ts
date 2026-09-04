import { REMOTE_CONTROL_MAX_PLAINTEXT_BYTES, REMOTE_CONTROL_PROTOCOL_VERSION, decodeBase64, encodeBase64 } from "./messages"

const ECDH_ALGORITHM = { name: "ECDH", namedCurve: "P-256" } as const
const FRAME_VERSION = 1
const IV_PREFIX_BYTES = 4
const IV_COUNTER_BYTES = 8
const MAX_COUNTER = (1n << BigInt(IV_COUNTER_BYTES * 8)) - 1n
const IV_BYTES = IV_PREFIX_BYTES + IV_COUNTER_BYTES
const TAG_BYTES = 16
const SESSION_KEY_BYTES = 32
const HANDSHAKE_NONCE_BYTES = 16
const KEY_INFO = new TextEncoder().encode("codenomad-remote-control-e2ee-v2")
const FRAME_AAD = new TextEncoder().encode("codenomad-remote-control-frame-v2")
const READY_PROOF = new TextEncoder().encode("codenomad-remote-control-ready-v2")

export interface EncryptedChannel {
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>
  decrypt(frame: Uint8Array): Promise<Uint8Array>
}

interface DirectionalKeys {
  clientToHost: CryptoKey
  hostToClient: CryptoKey
}

interface HelloMessage {
  type: "e2ee.hello"
  protocol: typeof REMOTE_CONTROL_PROTOCOL_VERSION
  publicKey: JsonWebKey
  nonce: string
}

interface ReadyMessage {
  type: "e2ee.ready"
  protocol: typeof REMOTE_CONTROL_PROTOCOL_VERSION
  nonce: string
  proof: string
}

export interface ClientHandshake {
  hello: string
  accept(message: string): Promise<EncryptedChannel>
}

export interface HostHandshake {
  accept(message: string): Promise<{ ready: string; channel: EncryptedChannel }>
}

export async function createClientHandshake(hostPublicJwk: JsonWebKey): Promise<ClientHandshake> {
  const hostPublicKey = await importPublicKey(hostPublicJwk)
  const ephemeral = await crypto.subtle.generateKey(ECDH_ALGORITHM, true, ["deriveBits"]) as CryptoKeyPair
  const nonce = crypto.getRandomValues(new Uint8Array(HANDSHAKE_NONCE_BYTES))
  const publicKey = await crypto.subtle.exportKey("jwk", ephemeral.publicKey)
  const hello: HelloMessage = {
    type: "e2ee.hello",
    protocol: REMOTE_CONTROL_PROTOCOL_VERSION,
    publicKey: publicJwk(publicKey),
    nonce: encodeBase64(nonce),
  }
  let accepted = false
  return {
    hello: JSON.stringify(hello),
    async accept(message: string) {
      if (accepted) throw new Error("Remote Control handshake was already accepted")
      const ready = parseReady(message)
      if (!ready) throw new Error("Invalid Remote Control host handshake")
      const hostNonce = decodeNonce(ready.nonce)
      const keys = await deriveKeys(ephemeral.privateKey, hostPublicKey, nonce, hostNonce)
      const channel = createChannel(keys.clientToHost, keys.hostToClient)
      const proof = await channel.decrypt(decodeBase64(ready.proof))
      if (!equalBytes(proof, READY_PROOF)) throw new Error("Remote Control host handshake authentication failed")
      accepted = true
      return channel
    },
  }
}

export async function createHostHandshake(hostPrivateJwk: JsonWebKey): Promise<HostHandshake> {
  const hostPrivateKey = await importPrivateKey(hostPrivateJwk)
  let accepted = false
  return {
    async accept(message: string) {
      if (accepted) throw new Error("Remote Control handshake was already accepted")
      const hello = parseHello(message)
      if (!hello) throw new Error("Invalid Remote Control client handshake")
      const clientNonce = decodeNonce(hello.nonce)
      const hostNonce = crypto.getRandomValues(new Uint8Array(HANDSHAKE_NONCE_BYTES))
      const clientPublicKey = await importPublicKey(hello.publicKey)
      const keys = await deriveKeys(hostPrivateKey, clientPublicKey, clientNonce, hostNonce)
      const channel = createChannel(keys.hostToClient, keys.clientToHost)
      const proof = await channel.encrypt(READY_PROOF)
      accepted = true
      const ready: ReadyMessage = {
        type: "e2ee.ready",
        protocol: REMOTE_CONTROL_PROTOCOL_VERSION,
        nonce: encodeBase64(hostNonce),
        proof: encodeBase64(proof),
      }
      return {
        ready: JSON.stringify(ready),
        channel,
      }
    },
  }
}

function createChannel(encryptionKey: CryptoKey, decryptionKey: CryptoKey): EncryptedChannel {
  const prefix = crypto.getRandomValues(new Uint8Array(IV_PREFIX_BYTES))
  let sendCounter = 0n
  let receiveCounter = 0n
  return {
    async encrypt(plaintext) {
      if (plaintext.byteLength > REMOTE_CONTROL_MAX_PLAINTEXT_BYTES) throw new Error("Remote Control encrypted frame is too large")
      if (sendCounter >= MAX_COUNTER) throw new Error("Remote Control encrypted channel counter is exhausted")
      sendCounter += 1n
      const iv = new Uint8Array(IV_BYTES)
      iv.set(prefix)
      writeCounter(iv, IV_PREFIX_BYTES, sendCounter)
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
        name: "AES-GCM",
        iv,
        additionalData: FRAME_AAD,
      }, encryptionKey, arrayBuffer(plaintext)))
      const frame = new Uint8Array(1 + IV_BYTES + ciphertext.byteLength)
      frame[0] = FRAME_VERSION
      frame.set(iv, 1)
      frame.set(ciphertext, 1 + IV_BYTES)
      return frame
    },
    async decrypt(frame) {
      if (frame.byteLength < 1 + IV_BYTES + TAG_BYTES || frame.byteLength > 1 + IV_BYTES + TAG_BYTES + REMOTE_CONTROL_MAX_PLAINTEXT_BYTES) {
        throw new Error("Invalid Remote Control encrypted frame size")
      }
      if (frame[0] !== FRAME_VERSION) throw new Error("Unsupported Remote Control encrypted frame")
      const iv = frame.slice(1, 1 + IV_BYTES)
      const counter = readCounter(iv, IV_PREFIX_BYTES)
      if (counter <= receiveCounter) throw new Error("Remote Control encrypted frame was replayed")
      let plaintext: ArrayBuffer
      try {
        plaintext = await crypto.subtle.decrypt({
          name: "AES-GCM",
          iv,
          additionalData: FRAME_AAD,
        }, decryptionKey, arrayBuffer(frame.slice(1 + IV_BYTES)))
      } catch {
        throw new Error("Remote Control encrypted frame authentication failed")
      }
      receiveCounter = counter
      return new Uint8Array(plaintext)
    },
  }
}

async function deriveKeys(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  clientNonce: Uint8Array,
  hostNonce: Uint8Array,
): Promise<DirectionalKeys> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256)
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"])
  const salt = new Uint8Array(clientNonce.byteLength + hostNonce.byteLength)
  salt.set(clientNonce)
  salt.set(hostNonce, clientNonce.byteLength)
  const bits = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: arrayBuffer(salt),
    info: KEY_INFO,
  }, material, SESSION_KEY_BYTES * 2 * 8))
  return {
    clientToHost: await importAesKey(bits.slice(0, SESSION_KEY_BYTES)),
    hostToClient: await importAesKey(bits.slice(SESSION_KEY_BYTES)),
  }
}

function importAesKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", arrayBuffer(bytes), "AES-GCM", false, ["encrypt", "decrypt"])
}

function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  const normalized = publicJwk(jwk)
  return crypto.subtle.importKey("jwk", normalized, ECDH_ALGORITHM, false, [])
}

function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  if (typeof jwk.d !== "string") return Promise.reject(new Error("Invalid Remote Control private key"))
  return crypto.subtle.importKey("jwk", { ...publicJwk(jwk), d: jwk.d }, ECDH_ALGORITHM, false, ["deriveBits"])
}

function publicJwk(jwk: JsonWebKey): JsonWebKey {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("Invalid Remote Control public key")
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true }
}

function parseHello(value: string): HelloMessage | null {
  const parsed = parseObject(value)
  if (parsed?.type !== "e2ee.hello" || parsed.protocol !== REMOTE_CONTROL_PROTOCOL_VERSION) return null
  if (typeof parsed.publicKey !== "object" || parsed.publicKey === null || typeof parsed.nonce !== "string") return null
  return parsed as unknown as HelloMessage
}

function parseReady(value: string): ReadyMessage | null {
  const parsed = parseObject(value)
  if (parsed?.type !== "e2ee.ready" || parsed.protocol !== REMOTE_CONTROL_PROTOCOL_VERSION) return null
  if (typeof parsed.nonce !== "string" || typeof parsed.proof !== "string") return null
  return parsed as unknown as ReadyMessage
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function writeCounter(target: Uint8Array, offset: number, value: bigint): void {
  for (let index = IV_COUNTER_BYTES - 1; index >= 0; index -= 1) {
    target[offset + index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readCounter(source: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let index = 0; index < IV_COUNTER_BYTES; index += 1) value = (value << 8n) | BigInt(source[offset + index])
  return value
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function decodeNonce(value: string): Uint8Array {
  const nonce = decodeBase64(value)
  if (nonce.byteLength !== HANDSHAKE_NONCE_BYTES) throw new Error("Invalid Remote Control handshake nonce")
  return nonce
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index]
  return difference === 0
}
