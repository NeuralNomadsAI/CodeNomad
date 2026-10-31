import { contentDigest, contentText } from "./inspect-view"

/** Bytes one plugin registration holds for interrupt receipts, each serialized body
 * counted as UTF-16 code units (the digest's encoding). The same 32 MiB the
 * current-passage reader allows one display read's journal in this process. The largest
 * accepted receipt shape (200 conversations of 64 descendants, 240-character IDs) counts
 * about 6 MB with plain IDs, so several of them, or dozens of ordinary ones, stay held;
 * IDs that need heavy JSON escaping can push one past the budget, which never holds it. */
export const INTERRUPT_RECEIPT_BUDGET_BYTES = 32 * 1024 * 1024

interface Held { text: string; bytes: number; slots: Set<string> }

/** `mission.interrupt` receipts too large for one result, for exact receipt reads. Each
 * is held as its serialized original, content-addressed per owner, within an aggregate
 * byte budget that evicts the least recently held or read first, with its task slots. A
 * task's newest interruption replaces its previous receipt, a whole result included. A
 * read of a receipt no longer held finds nothing: nothing is replayed or re-observed. */
export class InterruptReceipts {
  /** `owner\0digest` → held receipt, least recently used first. */
  private readonly held = new Map<string, Held>()
  /** A task's slot (owner, resolved mission and task) → its newest held receipt. */
  private readonly slots = new Map<string, string>()
  private bytes = 0

  constructor(private readonly budget = INTERRUPT_RECEIPT_BUDGET_BYTES) {}

  /** Holds `receipt` as `slot`'s newest, replacing its previous one; returns its digest.
   * A receipt larger than the whole budget is not held. */
  hold(owner: string, slot: string, receipt: unknown): string {
    const text = contentText(receipt), digest = contentDigest(text), key = `${owner}\0${digest}`
    this.retire(slot)
    const entry = this.held.get(key) ?? { text, bytes: 2 * text.length, slots: new Set<string>() }
    if (entry.bytes > this.budget) return digest
    if (!this.held.delete(key)) this.bytes += entry.bytes
    entry.slots.add(slot)
    this.held.set(key, entry)
    this.slots.set(slot, key)
    for (const [oldest] of this.held) {
      if (this.bytes <= this.budget) break
      this.drop(oldest)
    }
    return digest
  }

  /** `slot`'s newest interruption needs no continuation: its previous receipt goes. */
  retire(slot: string): void {
    const key = this.slots.get(slot)
    if (key === undefined) return
    this.slots.delete(slot)
    const entry = this.held.get(key)
    if (!entry) return
    entry.slots.delete(slot)
    if (!entry.slots.size) this.drop(key)
  }

  /** The exact original receipt `owner` holds under `digest`, refreshed as recently
   * used; undefined once evicted or replaced, or never held. */
  read(owner: string, digest: string): unknown {
    const key = `${owner}\0${digest}`, entry = this.held.get(key)
    if (!entry) return undefined
    this.held.delete(key)
    this.held.set(key, entry)
    return JSON.parse(entry.text)
  }

  /** The bytes held, as counted against the budget. */
  get retainedBytes(): number { return this.bytes }

  clear(): void {
    this.held.clear()
    this.slots.clear()
    this.bytes = 0
  }

  private drop(key: string): void {
    const entry = this.held.get(key)
    if (!entry) return
    this.held.delete(key)
    this.bytes -= entry.bytes
    for (const slot of entry.slots) if (this.slots.get(slot) === key) this.slots.delete(slot)
  }
}
