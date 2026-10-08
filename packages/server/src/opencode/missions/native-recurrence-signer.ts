import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto"
import { Effect } from "effect"
import { rejectAuthority } from "../../missions/authority-protocol"

/** Call only inside the owning native BEGIN IMMEDIATE transaction. An INSERT
 * without replacement is the single-writer CAS; never provision before it. */
export const acquireRecurrenceSigner = Effect.fn("missions.acquireRecurrenceSigner")(function* (
  read: () => Effect.Effect<unknown, unknown>, insertIfAbsent: (secret: string) => Effect.Effect<unknown, unknown>,
  play: boolean,
) {
  let secret = yield* read()
  if (secret === undefined && play) {
    const generated = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    yield* insertIfAbsent(generated)
    secret = yield* read()
  }
  if (typeof secret !== "string" || secret.length > 512) rejectAuthority("untrusted-signer")
  const privateKey = createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" })
  if (privateKey.asymmetricKeyType !== "ed25519") rejectAuthority("untrusted-signer")
  return { privateKey, publicKey: createPublicKey(privateKey), secret }
})
