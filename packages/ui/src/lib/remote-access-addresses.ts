import type { NetworkAddress } from "../../../server/src/api-types"

export interface RemoteAddressGroups {
  recommended: NetworkAddress | null
  hidden: NetworkAddress[]
}

export function splitRemoteAddresses(addresses: NetworkAddress[]): RemoteAddressGroups {
  const remoteAddresses = addresses.filter((address) => address.scope !== "loopback")
  return {
    recommended: remoteAddresses[0] ?? null,
    hidden: remoteAddresses.slice(1),
  }
}
