/** Shared internal SQL expression: native history reads ordinal parts first, then any
 * inline tail. Callers own storage validation, message/byte bounds and fences. */
export const nativeAssistantContentSQL = (messageID: string, inlineData: string) => `(SELECT json_group_array(json(part)) FROM (
  SELECT 0 AS source,ordinal AS position,data AS part FROM session_part WHERE message_id=${messageID}
  UNION ALL SELECT 1,CAST(key AS INTEGER),value FROM json_each(${inlineData},'$.content') ORDER BY source,position))`
