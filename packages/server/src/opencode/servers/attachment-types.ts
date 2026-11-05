/** Transient metadata. Directories on explicit servers retain their exact spelling. */
export interface ServerAttachmentReservation {
  reservationId: string
  serverId: string
  directory: string
  instanceId?: string
  state: "reserved" | "published"
}

export interface ServerAttachmentReservations {
  receipt: string
  status: "complete" | "unknown"
  reservations: readonly ServerAttachmentReservation[]
  inFlight: boolean
}
