/** Native assistant reads prefer ordinal session_part rows, retaining inline
 * content when none exist. Callers alias session_message as `m` and keep their
 * existing message/byte bounds and transaction graph. */
export const nativeMessageDataSQL = `CASE WHEN m.type='assistant' AND EXISTS(
  SELECT 1 FROM session_part WHERE message_id=m.id)
  THEN json_set(m.data,'$.content',json((SELECT json_group_array(json(data)) FROM
    (SELECT data FROM session_part WHERE message_id=m.id ORDER BY ordinal))))
  ELSE m.data END`
