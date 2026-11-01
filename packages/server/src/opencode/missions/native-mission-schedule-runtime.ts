import type { Plugin } from "@opencode/plugin/effect"
import { Rpc } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { nativeInvocation } from "./native-invocation"
import { registerNativeScheduledBusinessRpc } from "./native-scheduled-business-rpc"
import { registerNativeScheduleProvider } from "./native-schedule-provider-registration"
import { NativeScheduleTransportRpc } from "./native-schedule-transport-contract"
import { nativeMissionScheduleWakeHandlers } from "./native-mission-schedule-wake-rpc"
import { registerNativeMissionScheduleCarrierHooks } from "./native-mission-schedule-wake-hooks"
import type { NativeScheduleArtifacts } from "./native-schedule-installation"
import type { NativeDocumentBusiness } from "./desktop-plugin"
import { registerNativeMissionScheduleIdleHints } from "./native-mission-schedule-wake-idle"
import { registerNativeMissionScheduleMaintenance } from "./native-mission-schedule-wake-maintenance"

/** Setup owns public registrations only. Private calendar/business services are
 * acquired by each receiving HTTP RPC, including after a service restart. */
export const registerNativeMissionScheduleRuntime = Effect.fn("missions.registerScheduleRuntime")(function* (
  ctx: Plugin.Context, artifacts?: NativeScheduleArtifacts, invocation = nativeInvocation(),
) {
  if (artifacts) yield* registerNativeScheduleProvider(ctx, artifacts)
  const idle = yield* registerNativeMissionScheduleIdleHints(ctx)
  yield* registerNativeMissionScheduleCarrierHooks(ctx, idle.remember)
  yield* ctx.rpc.register(Rpc.define(NativeScheduleTransportRpc), nativeMissionScheduleWakeHandlers(ctx, artifacts)).pipe(Effect.orDie)
  yield* registerNativeMissionScheduleMaintenance(ctx)
  // One registration, shared by persistent native tool routing and preparation.
  const business: NativeDocumentBusiness = yield* registerNativeScheduledBusinessRpc(ctx, artifacts, invocation)
  return business
})
