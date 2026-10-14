import type { IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import type { FastifyRequest } from "fastify"
import { isLoopbackAddress } from "../auth/http-auth"

// Sockets accepted by the Remote Control ingress. Tunnelled traffic reaches that
// listener from loopback, so membership, not the peer address, decides authority.
const remoteSockets = new WeakSet<Socket>()
// Paired device authenticated for a remote request by the ingress gate.
const remoteDevices = new WeakMap<IncomingMessage, string>()

export function attachRemoteDevice(request: Pick<FastifyRequest, "raw">, deviceId: string): void {
  remoteDevices.set(request.raw, deviceId)
}

export function remoteDeviceOf(request: Pick<FastifyRequest, "raw">): string | undefined {
  return remoteDevices.get(request.raw)
}

export function markRemoteSocket(socket: Socket): void {
  remoteSockets.add(socket)
}

export function isRemoteSocket(socket: Socket | undefined): boolean {
  return socket !== undefined && remoteSockets.has(socket)
}

export function isRemoteRequest(request: Pick<FastifyRequest, "raw">): boolean {
  return isRemoteSocket(request.raw.socket)
}

/** A request from this machine's own listeners, never a tunnelled one. */
export function isLocalRequest(request: Pick<FastifyRequest, "raw">): boolean {
  return !isRemoteRequest(request) && isLoopbackAddress(request.raw.socket?.remoteAddress)
}
