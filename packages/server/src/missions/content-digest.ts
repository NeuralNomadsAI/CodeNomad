import { createHash } from "node:crypto"

/** SHA-256 of the text's UTF-16 code units, so strings differing only in unpaired
 * surrogates (which UTF-8 encodes alike) keep distinct digests. */
export function contentDigest(text: string): string {
  return createHash("sha256").update(text, "utf16le").digest("base64url")
}
