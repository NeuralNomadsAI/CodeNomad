export type DeleteHoverState =
  | { kind: "none" }
  | { kind: "message"; messageId: string }
  | { kind: "part"; messageId: string; partId: string; partType?: string }
