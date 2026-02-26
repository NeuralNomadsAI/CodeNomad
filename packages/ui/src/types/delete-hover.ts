export type DeleteHoverState =
  | { kind: "none" }
  | { kind: "message"; messageId: string }
