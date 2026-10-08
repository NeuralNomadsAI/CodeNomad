import { realpathSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { canonicalAuthority, rejectAuthority, type AuthoritySignerSnapshot, type ProvisionedAuthoritySigner } from "../../missions/authority-protocol"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import { parseRecurrenceDocument } from "../../missions/recurrence-contract"
import { physical } from "../../missions/host-authority/private-files"
import { type RecurrenceChildRecord, type RecurrenceEffectRecord,
  type SignedRecurrenceStandingIntent } from "../../missions/recurrence-authority-contract"
import { RecurrenceAuthority, recurrenceQualificationDigest, type RecurrenceAuthorityAdapter,
  type RecurrenceQualificationRequest } from "../../missions/recurrence-authority-core"
import type { RecurrenceAuthorityDocument, NativeRecurrenceAuthorityStore } from "../../missions/recurrence-authority-store"
import { createFamilyAuthorityIdentityFence, readFamilyAuthorityIdentitySync } from "../../workspaces/family-authority-claim"
import type { NativeRecurrenceAuthorityProvider } from "./native-authority-provider"
import type { NativeRecurrenceOwner } from "./native-authority-provider"
import type { NativeCreateInput, NativeRecurrenceLifecycleCommand } from "./native-service-adapter"
import { authorityDigest } from "../../missions/authority-protocol"
import type { MissionStorage } from "../../missions/journal"
import { observeNativeRecurrenceSettlement } from "./native-recurrence-settlement"
import { recurrenceInput, recurrenceReadEvidence, recurrenceSourceLocationDigest } from "../../missions/recurrence-input"
import type { NativeSourceReadInput } from "./native-service-adapter"
import type { RecurrenceEffectReceipt } from "../../missions/recurrence-authority-contract"
import { recurrenceInputBudget } from "../../missions/recurrence-read-budget"

const same = (a: unknown, b: unknown) => canonicalAuthority(a, 768 * 1024) === canonicalAuthority(b, 768 * 1024)

/** Due work reads the Play-owned native key, archived signed parent and current
 * schedule/ledger. A human decision is admitted only by authenticated Play;
 * due execution never calls captureHumanIntent or signs another decision. */
export interface NativeStandingSigner {
  readSigners(): Promise<readonly ProvisionedAuthoritySigner[]>
  assertSignerCurrent(signer: AuthoritySignerSnapshot): true
  assertProtectedCurrent(request: Readonly<RecurrenceQualificationRequest>): true
  captureHumanIntent(parent: SignedRecurrenceStandingIntent): () => true
}

/** In-flight native call owned by the admission module, never an RPC value.
 * Only the original call may expose its positive native return as a receipt. */
export type NativeRecurrenceInvocation = {
  operationID: string
  input: { kind: "create"; request: NativeCreateInput }
    | { kind: "start"; sessionID: string; variables: Record<string, string> }
    | { kind: "coordinator-message"; command: NativeRecurrenceLifecycleCommand }
    | { kind: "inbox-read"; request: NativeSourceReadInput }
  acknowledgement?: RecurrenceEffectReceipt
}

/** Native capability + signed parent + fresh physical Git family identity.
 * Construction never enrolls an anchor, creates a key or opens a new database. */
export function nativeRecurrenceAdapter(input: {
  provider: NativeRecurrenceAuthorityProvider
  signer: NativeStandingSigner
  owner: NativeRecurrenceOwner
  invocation?: () => NativeRecurrenceInvocation | undefined
  settlementStorage?: MissionStorage
  observeSettlement?: RecurrenceAuthorityAdapter["observeSettlement"]
}): RecurrenceAuthorityAdapter {
  const { provider, signer } = input, store = provider.store
  // Adapter/provider-local discovery contracts, not signer or epoch approvals.
  // Reuse only an exact root binding; each boundary still invokes its fresh fence.
  const signerRoots = new Map<string, () => string>()
  const owner = (): true => {
    assertSynchronousAuthorityGuard(input.owner.assertCurrent, "policy-unqualified")
    if (input.owner.namespace !== store.scope.namespace || input.owner.daemonStorageID !== store.scope.daemonStorageID)
      rejectAuthority("binding-mismatch")
    if (provider.location.projectID !== store.scope.projectID || provider.location.projectCanonical !== store.scope.projectCanonical)
      rejectAuthority("binding-mismatch")
    return provider.assertCurrent()
  }
  const protectedCurrent = (request: Readonly<RecurrenceQualificationRequest>): true => {
    owner()
    return assertSynchronousAuthorityGuard(() => signer.assertProtectedCurrent(request), "policy-unqualified")
  }
  const rootCurrent = (roots: readonly SignedRecurrenceStandingIntent["body"]["roots"][number][], fences: ReadonlyMap<string, () => string>): true => {
    for (const root of roots) {
      if (root.mode !== "git" || physical(realpathSync(root.directory)) !== root.checkout
        || physical(realpathSync(root.family)) !== root.family
        || (fences.get(canonicalAuthority(root))?.() ?? readFamilyAuthorityIdentitySync(root.directory)) !== root.family)
        rejectAuthority("binding-mismatch")
    }
    return true
  }
  const ledger = (target: NativeRecurrenceAuthorityStore, expected: Readonly<RecurrenceAuthorityDocument> | null): true => {
    owner()
    if (target !== store || !same(provider.readCurrent(store.key) ?? null, expected)) rejectAuthority("revision-conflict")
    return true
  }
  const pending = (parent: SignedRecurrenceStandingIntent): true => {
    const key = `${store.parentKey}/parents/${parent.body.epoch + 1}`
    if (provider.readCurrent(key) !== undefined) rejectAuthority("authorization-blocked")
    return true
  }
  return {
    readSigners: async () => {
      owner(); const signers = await signer.readSigners()
      for (const root of signers.flatMap(signer => signer.roots)) {
        const binding = canonicalAuthority(root)
        if (!signerRoots.has(binding)) signerRoots.set(binding, await createFamilyAuthorityIdentityFence(root.directory))
      }
      owner(); return signers
    },
    assertSignerCurrent: snapshot => { owner(); rootCurrent(snapshot.roots, signerRoots); return assertSynchronousAuthorityGuard(() => signer.assertSignerCurrent(snapshot), "untrusted-signer") },
    qualify: async (request, signal) => {
      signal.throwIfAborted()
      owner()
      if (!same(request.scope, store.scope) || request.parent.body.daemonStorageID !== provider.daemonStorageID
        || request.parent.body.namespace !== store.scope.namespace
        || !request.parent.body.roots.some(root => root.directory === provider.location.directory)
        || physical(await realpath(request.parent.body.projectCanonical)) !== physical(request.parent.body.projectCanonical))
        rejectAuthority("binding-mismatch")
      // Native Location and project were checked on provider acquisition. Verify
      // every exact physical checkout/family, not a directory prefix or a label.
      const roots = new Map<string, () => string>()
      for (const root of request.parent.body.roots) {
        const binding = canonicalAuthority(root)
        const fence = signerRoots.get(binding) ?? await createFamilyAuthorityIdentityFence(root.directory)
        if (root.mode !== "git" || physical(await realpath(root.directory)) !== root.checkout
          || physical(await realpath(root.family)) !== root.family || fence() !== root.family)
          rejectAuthority("binding-mismatch")
        signerRoots.set(binding, fence)
        roots.set(binding, fence)
      }
      const actualSource = provider.readCurrent(provider.sourceKey)
      if (actualSource === undefined) rejectAuthority("observation-unavailable")
      const source = parseRecurrenceDocument(actualSource, store.scope.projectID, store.scope.projectCanonical, store.scope.scheduleID)
      if (request.purpose === "human" && (source.scheduleRevision !== request.parent.body.scheduleRevision
        || !same(source.config, request.parent.body.config))) rejectAuthority("binding-mismatch")
      const human = request.purpose === "human" ? signer.captureHumanIntent(request.parent) : undefined
      const current = (): true => {
        signal.throwIfAborted()
        protectedCurrent(request)
        rootCurrent(request.parent.body.roots, roots)
        human && assertSynchronousAuthorityGuard(human, "policy-unqualified")
        ledger(store, request.ledger)
        if (request.purpose === "human") {
          const fresh = provider.readCurrent(provider.sourceKey)
          if (fresh === undefined || !same(parseRecurrenceDocument(fresh, store.scope.projectID,
            store.scope.projectCanonical, store.scope.scheduleID), source)) rejectAuthority("observation-unavailable")
        }
        // Only dispatch acquires a new effect lease. Receipt/terminal paths
        // reconcile the original child after a committed Pause/Stop; the core
        // still rejects a torn next-epoch parent before either transaction.
        if (request.purpose !== "human" && request.purpose !== "receipt" && request.purpose !== "settle")
          pending(request.ledger?.parent ?? request.parent)
        if (request.purpose === "reserve") {
          const actual = provider.readCurrent(provider.sourceKey)
          if (actual === undefined || !same(parseRecurrenceDocument(actual, store.scope.projectID,
            store.scope.projectCanonical, store.scope.scheduleID), request.document)) rejectAuthority("observation-unavailable")
        }
        if (request.purpose === "effect" || request.purpose === "receipt") {
          if (!request.effect || !request.ledger?.child || !same(request.ledger.child.parent, request.parent)
            || request.purpose === "receipt" && request.effect.receipt?.outcome !== "applied"
            || request.purpose === "receipt" && !request.ledger.child.effects.some(item => item.operationID === request.effect!.operationID
              && same(item.effect, request.effect!.effect))
            || request.purpose === "effect" && request.ledger.child.effects.some(item => item.operationID === request.effect!.operationID
              && !same(item.effect, request.effect!.effect))) rejectAuthority("binding-mismatch")
          if (provider.readCurrent(`${store.parentKey}/passages/${request.ledger.child.grant.passage.id}`) !== undefined)
            rejectAuthority("authorization-blocked")
        }
        return true
      }
      current()
      return { requestDigest: recurrenceQualificationDigest(request), assertCurrent: current }
    },
    assertLedgerCurrent: ledger,
    assertEffectCurrent: (target, child, operation) => {
      owner(); pending(child.parent)
      rootCurrent(child.parent.body.roots, signerRoots)
      const hot = provider.readCurrent(store.key) as RecurrenceAuthorityDocument | undefined
      if (target !== store || !hot || hot.parent.body.action !== "authorize" || !same(hot.parent, child.parent)
        || !same(hot.child, child) || provider.readCurrent(`${store.parentKey}/passages/${child.grant.passage.id}`) !== undefined
        || !hot.child?.effects.some(item => same(item, operation))) rejectAuthority("authorization-blocked")
      const call = input.invocation?.()
      if (!call || operation.receipt || call.operationID !== operation.operationID) rejectAuthority("effect-unavailable")
      const grant = child.grant, config = child.parent.body.config
      const metadata = { "codenomad.mission": { version: 1, missionID: grant.missionID, kind: "coordinator", role: "coordinator" } }
      if (operation.effect.kind === "create") {
        if (call.input.kind !== "create" || !same(call.input.request, {
          id: grant.coordinatorSessionID, title: `Mission coordinator: ${config.consigne}`.slice(0, 160),
          location: { directory: provider.location.directory }, metadata, ...config.profiles!.coordinator,
        })) rejectAuthority("binding-mismatch")
      } else if (operation.effect.kind === "start") {
        if (call.input.kind !== "start" || call.input.sessionID !== grant.coordinatorSessionID
          || !call.input.variables || !Object.values(call.input.variables).every(value => typeof value === "string")) rejectAuthority("binding-mismatch")
      } else if (operation.effect.kind === "coordinator-message") {
        for (const item of child.effects) {
          if (item.effect.kind === "inbox-read" && item.effect.read)
            provider.assertSourcePlacement(item.effect.conversationID, item.effect.read)
        }
        if (call.input.kind !== "coordinator-message" || operation.effect.messageID !== grant.messageID
          || operation.effect.contentDigest !== authorityDigest(call.input.command.input.text)
          || !same(call.input.command, { kind: "synthetic", input: recurrenceInput(child) })) rejectAuthority("binding-mismatch")
      } else if (operation.effect.kind === "inbox-read") {
        const { read, conversationID } = operation.effect
        if (!read || call.input.kind !== "inbox-read" || !same(call.input.request,
          { sessionID: operation.effect.conversationID, ...read })) rejectAuthority("binding-mismatch")
        const raw = provider.readCurrent(provider.sourceKey)
        const source = parseRecurrenceDocument(raw, store.scope.projectID, store.scope.projectCanonical, store.scope.scheduleID)
        const cursor = source.cursors.find(item => item.conversationID === conversationID)
        if (!same(source.config, config) || (cursor?.messageID ?? null) !== read.afterMessageID
          || cursor?.locationDigest !== undefined && cursor.locationDigest !== recurrenceSourceLocationDigest(read)) rejectAuthority("binding-mismatch")
        provider.assertSourcePlacement(operation.effect.conversationID, read)
      } else rejectAuthority("effect-unavailable")
      return true
    },
    observeEffect: async (child, operation) => {
      const call = input.invocation?.(), receipt = call?.acknowledgement
      if (!call || !receipt || call.operationID !== operation.operationID || receipt.operationID !== operation.operationID
        || (call.input.kind === "inbox-read" ? operation.effect.kind !== "inbox-read" || !operation.effect.read || !receipt.sourceMessages
          || receipt.sourceMessages.length > operation.effect.read.limit
          || canonicalAuthority(receipt.sourceMessages, 64 * 1024).length > operation.effect.read.contextLimit
          || receipt.evidenceID !== recurrenceReadEvidence(operation.effect, receipt.sourceMessages)
          : receipt.sourceMessages !== undefined || receipt.evidenceID !== (call.input.kind === "coordinator-message" ? child.grant.messageID : child.grant.coordinatorSessionID))) {
        rejectAuthority("observation-unavailable")
      }
      const current = (): true => {
        owner()
        if (operation.effect.kind === "inbox-read" && operation.effect.read)
          provider.assertSourcePlacement(operation.effect.conversationID, operation.effect.read)
        const hot = provider.readCurrent(store.key) as RecurrenceAuthorityDocument | undefined
        if (!same(call, input.invocation?.()) || !hot?.child || !same(hot.child.grant, child.grant)
          || !hot.child.effects.some(effect => same(effect, operation))
          || !same(hot.child.effects.find(effect => effect.operationID === operation.operationID)?.receipt, null)) {
          rejectAuthority("observation-unavailable")
        }
        return true
      }
      current()
      return { receipt, assertCurrent: current }
    },
    observeSettlement: input.observeSettlement ?? ((child: Readonly<RecurrenceChildRecord>, signal) => {
      if (!input.settlementStorage) rejectAuthority("observation-unavailable")
      return observeNativeRecurrenceSettlement(provider, input.settlementStorage, child, signal)
    }),
  }
}

/** Unactivated human-decision CAS construction seam. The protected signer
 * producer must provide an authenticated request-scoped native caller, its
 * independently checked reservation and owner enrollment at explicit Play.
 * This export alone is NOT a shipped Play route or an execution grant. */
export async function applyNativeStandingDecision(input: Parameters<typeof nativeRecurrenceAdapter>[0],
  parent: SignedRecurrenceStandingIntent, signal: AbortSignal): Promise<RecurrenceAuthorityDocument> {
  if (parent.body.action === "authorize" && !recurrenceInputBudget(parent.body.config).sufficient) rejectAuthority("capacity")
  const guard = input.signer.captureHumanIntent(parent)
  const current = (): true => {
    signal.throwIfAborted()
    assertSynchronousAuthorityGuard(guard, "policy-unqualified")
    assertSynchronousAuthorityGuard(input.owner.assertCurrent, "policy-unqualified")
    return input.provider.assertCurrent()
  }
  return input.provider.transact(current, async () => {
    current()
    const authority = new RecurrenceAuthority(input.provider.store, nativeRecurrenceAdapter(input))
    const result = await authority.authorize(parent, signal)
    current()
    if (!same(await input.provider.read(), result)) rejectAuthority("revision-conflict")
    return result
  })
}
