import { nativeAssistantContentSQL } from "../session-pruning/native-assistant-content"

/** Native assistant reads combine ordinal session_part rows and the inline tail.
 * Callers alias session_message as `m` and keep their
 * existing message/byte bounds and transaction graph. */
export const nativeMessageDataSQL = `CASE WHEN m.type='assistant' AND EXISTS(
  SELECT 1 FROM session_part WHERE message_id=m.id)
  THEN json_set(m.data,'$.content',json(${nativeAssistantContentSQL("m.id", "m.data")}))
  ELSE m.data END`
