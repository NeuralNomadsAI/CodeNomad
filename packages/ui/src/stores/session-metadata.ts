import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
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

function mergeCodeNomadMetadata(
  metadata: MetadataRecord,
  updater: (current: CodeNomadSessionMetadata) => CodeNomadSessionMetadata,
): MetadataRecord {
  const currentCodeNomad = isRecord(metadata[CODENOMAD_METADATA_KEY])
    ? { ...(metadata[CODENOMAD_METADATA_KEY] as MetadataRecord) }
    : {}
  const nextCodeNomad = updater(normalizeCodeNomadMetadata(currentCodeNomad))
  const mergedCodeNomad: MetadataRecord = {
    ...currentCodeNomad,
    ...nextCodeNomad,
    version: CODENOMAD_METADATA_VERSION,
  }

  if (!nextCodeNomad.worktreeSlug) {
    delete mergedCodeNomad.worktreeSlug
  }

  return {
    ...metadata,
    [CODENOMAD_METADATA_KEY]: mergedCodeNomad,
  }
}

export function getSessionMetadata(instanceId: string, sessionId: string): MetadataRecord {
  return normalizeMetadata(sessions().get(instanceId)?.get(sessionId)?.metadata)
}

export function getCodeNomadSessionMetadata(instanceId: string, sessionId: string): CodeNomadSessionMetadata {
  return normalizeCodeNomadMetadata(getSessionMetadata(instanceId, sessionId)[CODENOMAD_METADATA_KEY])
}

export async function updateSessionMetadataWithClient(
  client: OpencodeClient,
  instanceId: string,
  sessionId: string,
  updater: (metadata: MetadataRecord) => MetadataRecord,
): Promise<MetadataRecord> {
  const latest = await requestData<any>(client.session.get({ sessionID: sessionId }), "session.get")
  const nextMetadata = updater(normalizeMetadata(latest?.metadata))
  const updated = await requestData<any>(
    client.session.update({ sessionID: sessionId, metadata: nextMetadata } as any),
    "session.update",
  )
  const persistedMetadata = normalizeMetadata(updated?.metadata ?? nextMetadata)

  withSession(instanceId, sessionId, (session) => {
    session.metadata = persistedMetadata
  })

  return persistedMetadata
}

export async function hydrateSessionMetadataWithClient(
  client: OpencodeClient,
  instanceId: string,
  sessionId: string,
  query?: { workspace?: string },
): Promise<MetadataRecord> {
  const expectedMetadata = sessions().get(instanceId)?.get(sessionId)?.metadata
  const latest = await requestData<any>(client.session.get({ sessionID: sessionId, ...query }), "session.get")
  const metadata = normalizeMetadata(latest?.metadata)

  withSession(instanceId, sessionId, (session) => {
    if (session.metadata !== expectedMetadata || !shouldReplaceSessionMetadata(session.metadata)) return false
    session.metadata = metadata
  })

  return metadata
}

export async function updateCodeNomadSessionMetadataWithClient(
  client: OpencodeClient,
  instanceId: string,
  sessionId: string,
  updater: (metadata: CodeNomadSessionMetadata) => CodeNomadSessionMetadata,
): Promise<CodeNomadSessionMetadata> {
  const persisted = await updateSessionMetadataWithClient(client, instanceId, sessionId, (metadata) =>
    mergeCodeNomadMetadata(metadata, updater),
  )
  return normalizeCodeNomadMetadata(persisted[CODENOMAD_METADATA_KEY])
}

export async function setSessionWorktreeSlugWithClient(
  client: OpencodeClient,
  instanceId: string,
  sessionId: string,
  worktreeSlug: string,
): Promise<void> {
  await updateCodeNomadSessionMetadataWithClient(client, instanceId, sessionId, (metadata) => ({
    ...metadata,
    worktreeSlug,
  }))
}
