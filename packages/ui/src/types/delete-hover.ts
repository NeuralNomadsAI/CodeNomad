export type DeleteHoverState =
  | { kind: "none" }
  | { kind: "message"; messageId: string }
  | { kind: "deleteUpTo"; messageId: string }
