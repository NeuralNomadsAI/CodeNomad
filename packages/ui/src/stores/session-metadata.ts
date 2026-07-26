import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { serverApi } from "../lib/api-client"
import { requestData } from "../lib/opencode-api"
import { sessions, withSession } from "./session-state"
import { shouldReplaceSessionMetadata } from "./session-metadata-completeness"

const CODENOMAD_METADATA_KEY = "codenomad"
const CODENOMAD_METADATA_VERSION = 1

export interface CodeNomadSessionMetadata {
  version: 1
  worktreeSlug?: string
}

type MetadataRecord = Record<string, unknown>

function isRecord(value: unknown): value is MetadataRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeMetadata(value: unknown): MetadataRecord {
  return isRecord(value) ? { ...value } : {}
}

function normalizeCodeNomadMetadata(value: unknown): CodeNomadSessionMetadata {
  const source = isRecord(value) ? value : {}
  const metadata: CodeNomadSessionMetadata = { version: CODENOMAD_METADATA_VERSION }
  if (typeof source.worktreeSlug === "string" && source.worktreeSlug.trim()) {
    metadata.worktreeSlug = source.worktreeSlug
  }
  return metadata
}

export function getSessionMetadata(instanceId: string, sessionId: string): MetadataRecord {
  return normalizeMetadata(sessions().get(instanceId)?.get(sessionId)?.metadata)
}

export function getCodeNomadSessionMetadata(instanceId: string, sessionId: string): CodeNomadSessionMetadata {
  return normalizeCodeNomadMetadata(getSessionMetadata(instanceId, sessionId)[CODENOMAD_METADATA_KEY])
}

export async function hydrateSessionMetadataWithClient(
  client: OpencodeClient,
  instanceId: string,
  sessionId: string,
  query?: { workspace?: string },
  isCurrent: () => boolean = () => true,
): Promise<MetadataRecord> {
  const expectedMetadata = sessions().get(instanceId)?.get(sessionId)?.metadata
  const latest = await requestData<any>(client.session.get({ sessionID: sessionId, ...query }), "session.get")
  const metadata = normalizeMetadata(latest?.metadata)
  if (!isCurrent()) return metadata

  withSession(instanceId, sessionId, (session) => {
    if (session.metadata !== expectedMetadata || !shouldReplaceSessionMetadata(session.metadata)) return false
    session.metadata = metadata
  })

  return metadata
}

export async function setSessionWorktreeSlug(
  instanceId: string,
  sessionId: string,
  worktreeSlug: string,
): Promise<void> {
  const { metadata } = await serverApi.setSessionWorktreeSlug(instanceId, sessionId, worktreeSlug)
  withSession(instanceId, sessionId, (session) => {
    session.metadata = normalizeMetadata(metadata)
  })
}
