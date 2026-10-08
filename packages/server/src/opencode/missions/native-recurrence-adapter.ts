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
import { readFamilyAuthorityIdentity, readFamilyAuthorityIdentitySync, type SynchronousFamilyAuthorityClaim } from "../../workspaces/family-authority-claim"
import type { NativeRecurrenceAuthorityProvider } from "./native-authority-provider"
import type { acquireNativeManagedOwner } from "./native-managed-owner"
import type { NativeCreateInput, NativeRecurrenceLifecycleCommand } from "./native-service-adapter"
import { authorityDigest } from "../../missions/authority-protocol"
import { controlOperationID } from "../../missions/receipt-identity"
import type { MissionStorage } from "../../missions/journal"
import { observeNativeRecurrenceSettlement } from "./native-recurrence-settlement"

const same = (a: unknown, b: unknown) => canonicalAuthority(a, 768 * 1024) === canonicalAuthority(b, 768 * 1024)

/** Supplied only by the protected HUMAN signing producer, never by RPC input.
 * Its synchronous check reads the independent private checkpoint/reservation,
 * including the exact previous native ledger head and the original human request.
 * Merely possessing an Ed25519 signature is not human admission. */
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
  acknowledgement?: { operationID: string; outcome: "applied"; evidenceID: string }
}

/** Native capability + original protected signer + held physical family claims.
 * Construction never enrolls an anchor, creates a key or opens a new database. */
export function nativeRecurrenceAdapter(input: {
  provider: NativeRecurrenceAuthorityProvider
  signer: NativeStandingSigner
  owner: import("effect").Effect.Success<ReturnType<typeof acquireNativeManagedOwner>>
  familyClaims: ReadonlyMap<string, SynchronousFamilyAuthorityClaim>
  invocation?: () => NativeRecurrenceInvocation | undefined
  settlementStorage?: MissionStorage
}): RecurrenceAuthorityAdapter {
  const { provider, signer } = input, store = provider.store
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
  const rootCurrent = (roots: readonly SignedRecurrenceStandingIntent["body"]["roots"][number][]): true => {
    for (const root of roots) {
      if (root.mode !== "git" || physical(realpathSync(root.directory)) !== root.checkout
        || physical(realpathSync(root.family)) !== root.family || readFamilyAuthorityIdentitySync(root.directory) !== root.family)
        rejectAuthority("binding-mismatch")
      const claim = input.familyClaims.get(root.family)
      if (!claim) rejectAuthority("authorization-blocked")
      assertSynchronousAuthorityGuard(claim.assertCurrentSync, "policy-unqualified")
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
    readSigners: async () => { owner(); const signers = await signer.readSigners(); owner(); return signers },
    assertSignerCurrent: snapshot => { owner(); rootCurrent(snapshot.roots); return assertSynchronousAuthorityGuard(() => signer.assertSignerCurrent(snapshot), "untrusted-signer") },
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
      for (const root of request.parent.body.roots) {
        if (root.mode !== "git" || physical(await realpath(root.directory)) !== root.checkout
          || physical(await realpath(root.family)) !== root.family || await readFamilyAuthorityIdentity(root.directory) !== root.family)
          rejectAuthority("binding-mismatch")
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
        rootCurrent(request.parent.body.roots)
        human && assertSynchronousAuthorityGuard(human, "policy-unqualified")
        ledger(store, request.ledger)
        if (request.purpose === "human") {
          const fresh = provider.readCurrent(provider.sourceKey)
          if (fresh === undefined || !same(parseRecurrenceDocument(fresh, store.scope.projectID,
            store.scope.projectCanonical, store.scope.scheduleID), source)) rejectAuthority("observation-unavailable")
        }
        if (request.purpose !== "human") pending(request.ledger?.parent ?? request.parent)
        if (request.purpose === "reserve") {
          const actual = provider.readCurrent(provider.sourceKey)
          if (actual === undefined || !same(parseRecurrenceDocument(actual, store.scope.projectID,
            store.scope.projectCanonical, store.scope.scheduleID), request.document)) rejectAuthority("observation-unavailable")
        }
        if (request.purpose === "effect" || request.purpose === "receipt") {
          if (!request.effect || !request.ledger?.child || !same(request.ledger.child.parent, request.parent)
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
        if (call.input.kind !== "coordinator-message" || operation.effect.messageID !== grant.messageID
          || operation.effect.contentDigest !== authorityDigest(call.input.command.input.text)
          || !same(call.input.command, { kind: "synthetic", input: {
            sessionID: grant.coordinatorSessionID, id: grant.messageID, text: config.consigne,
            description: "CodeNomad recurring mission start", delivery: "queue", resume: true,
            metadata: { "codenomad.mission": { version: 1, missionID: grant.missionID, kind: "lifecycle",
              operationID: controlOperationID(grant.missionID, grant.passage.id), taskMode: config.taskMode, recurrence: {
                grantID: grant.grantID, passageID: grant.passage.id, messageID: grant.messageID,
                coordinatorSessionID: grant.coordinatorSessionID } } },
          } })) rejectAuthority("binding-mismatch")
      } else rejectAuthority("effect-unavailable")
      return true
    },
    observeEffect: async (child, operation) => {
      const call = input.invocation?.(), receipt = call?.acknowledgement
      if (!call || !receipt || call.operationID !== operation.operationID || receipt.operationID !== operation.operationID
        || receipt.evidenceID !== (call.input.kind === "coordinator-message" ? child.grant.messageID : child.grant.coordinatorSessionID)) {
        rejectAuthority("observation-unavailable")
      }
      const current = (): true => {
        owner()
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
    observeSettlement: (child: Readonly<RecurrenceChildRecord>, signal) => {
      if (!input.settlementStorage) rejectAuthority("observation-unavailable")
      return observeNativeRecurrenceSettlement(provider, input.settlementStorage, child, signal)
    },
  }
}

/** Unactivated human-decision CAS construction seam. The protected signer
 * producer must provide an authenticated request-scoped native caller, its
 * independently checked reservation and owner enrollment at explicit Play.
 * This export alone is NOT a shipped Play route or an execution grant. */
export async function applyNativeStandingDecision(input: Parameters<typeof nativeRecurrenceAdapter>[0],
  parent: SignedRecurrenceStandingIntent, signal: AbortSignal): Promise<RecurrenceAuthorityDocument> {
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
