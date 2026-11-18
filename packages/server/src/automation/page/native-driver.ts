import { operationDriver } from "./driver"
import { PAGE_DRIVER_VERSION, type DriverKind, type PageOperation } from "./protocol"

export function nativeDriver(descriptor: {driver?: unknown; contractVersion?: unknown}, send: (operation: PageOperation) => Promise<Record<string, unknown>>, checkpoint: () => Promise<void>) {
  if (!descriptor || (descriptor.driver !== "cdp" && descriptor.driver !== "webkit") || descriptor.contractVersion !== PAGE_DRIVER_VERSION) throw new Error("Unsupported native browser page driver contract")
  return operationDriver(descriptor.driver as DriverKind, send, checkpoint)
}
