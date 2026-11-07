import type { FastifyReply, FastifyRequest } from "fastify"
import { routedPath } from "../server/routed-path"
import { isRemoteRequest } from "./request-origin"

export const SERVER_PAIR_PATH = "/api/remote-control/server-pair"
const forbidden = /^(origin|cookie2?|authorization|proxy-authorization|referer|sec-fetch-.*|access-control-request-.*)$/i

/** Ambient browser context, including present but empty headers. */
export function hasBrowserRequestContext(request: FastifyRequest): boolean {
  return Object.keys(request.headers).some(name => /^(origin|referer|sec-.*|access-control-request-.*)$/i.test(name))
}

/** Dedicated non-browser protocol. Presence, including empty headers, is a refusal. */
export function validServerPairRequest(request: FastifyRequest): boolean {
  return request.method === "POST"
    && request.headers["x-codenomad-server-pairing"] === "1"
    && request.headers["content-type"] === "application/json"
    && !hasBrowserRequestContext(request)
    && !Object.keys(request.headers).some(name => forbidden.test(name))
}

/** Runs globally before CORS, including its wildcard OPTIONS route and direct listeners. */
export function guardServerPairRequest(request: FastifyRequest, reply: FastifyReply): boolean {
  if (routedPath(request.raw.url ?? request.url) !== SERVER_PAIR_PATH) return false
  reply.header("Cache-Control", "no-store")
  if (!isRemoteRequest(request) || !validServerPairRequest(request)) {
    reply.header("connection", "close").code(!isRemoteRequest(request) ? 404 : 403).send(request.method === "HEAD" ? "" : { error: "Server pairing request rejected" })
    return true
  }
  return false
}
