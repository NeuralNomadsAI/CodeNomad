export const TRANSCRIPTION_BODY_LIMIT = 1024 * 1024
// Base64 expands audio by 4/3. Leave room for JSON and MIME metadata.
export const TRANSCRIPTION_AUDIO_LIMIT = (TRANSCRIPTION_BODY_LIMIT - 4096) / 4 * 3
