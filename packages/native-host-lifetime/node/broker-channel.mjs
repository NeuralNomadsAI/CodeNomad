// Internal S-to-Node fixture broker transport. NOT the production M/S ABI.
import net from "node:net"
import { randomBytes } from "node:crypto"
import { consumeBootstrap } from "./runtime-bootstrap.mjs"
import { equal, framed, MAX_PENDING, proof, write } from "./channel-codec.mjs"

export async function connectServiceBroker() {
  const boot = await consumeBootstrap({ role: "broker" })
  const socket = net.createConnection(boot.pipe)
  const challenge = randomBytes(32).toString("hex")
  let stopped = false, authenticated = false, incoming = 0, receiveRequest
  const subscribers = new Set(), prepared = []
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const fail = () => {
    if (stopped) return
    stopped = true; socket.destroy(); readyReject(new Error("native-channel-closed"))
    for (const listener of subscribers) listener()
  }
  const timer = setTimeout(fail, 5000)
  socket.once("error", fail); socket.once("end", fail); socket.once("close", () => { clearTimeout(timer); fail() })
  framed(socket, value => {
    if (!authenticated) {
      if (value?.v !== 1 || value.hello !== true || value.profile !== boot.profile || value.generation !== boot.generation
        || value.role !== boot.role || value.challenge !== challenge
        || value.peer?.pid !== boot.peer.pid || value.peer?.creationFiletime !== boot.peer.creationFiletime
        || value.supervisor?.pid !== boot.supervisor.pid || value.supervisor?.creationFiletime !== boot.supervisor.creationFiletime
        || !equal(value.proof, proof(boot, challenge, "server"))) { fail(); return }
      authenticated = true; clearTimeout(timer); readyResolve(); return
    }
    if (value?.v !== 1 || value.profile !== boot.profile || value.generation !== boot.generation
      || !["service.start", "cancel", "shutdown"].includes(value.method) || value.id !== ++incoming
      || !Number.isSafeInteger(value.deadline) || value.deadline <= Date.now() || value.deadline > Date.now() + 30000) { fail(); return }
    if (!receiveRequest) { if (prepared.length >= MAX_PENDING) { fail(); return }; prepared.push(value) }
    else receiveRequest(value)
  }, fail)
  socket.once("connect", () => {
    write(socket, { v: 1, profile: boot.profile, generation: boot.generation, role: boot.role, peer: boot.peer,
      challenge, proof: proof(boot, challenge, "client") }).catch(fail)
  })
  await ready
  return Object.freeze({ application: boot.application,
    onDisconnect(listener) { subscribers.add(listener); return () => subscribers.delete(listener) },
    bindBroker(handler) {
      if (receiveRequest) throw new Error("native-role-refused")
      receiveRequest = handler
      for (const value of prepared.splice(0)) handler(value)
    },
    reply(id, result, error) { return write(socket, { v: 1, id, profile: boot.profile, generation: boot.generation,
      ...(error ? { error: "native-service-refused" } : { result }) }).catch(fail) },
  })
}
