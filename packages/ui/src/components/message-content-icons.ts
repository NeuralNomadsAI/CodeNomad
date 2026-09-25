import {
  BookOpen,
  Brain,
  CheckSquare,
  ClipboardCheck,
  Code,
  Coins,
  FileEdit,
  Globe,
  GraduationCap,
  HelpCircle,
  LayoutGrid,
  Link2,
  LogIn,
  Paperclip,
  Pencil,
  Search,
  Info,
  Stethoscope,
  Terminal,
  X,
} from "lucide-solid"

export type MessageContentIcon = typeof Brain

const contentIcons = {
  thinking: Brain,
  diagnostics: Stethoscope,
  inputs: LogIn,
  usage: Coins,
  system: Info,
  bash: Terminal,
  read: BookOpen,
  write: FileEdit,
  edit: Pencil,
  patch: Paperclip,
  apply_patch: Link2,
  webfetch: Globe,
  glob: Search,
  grep: Search,
  todowrite: ClipboardCheck,
  task: CheckSquare,
  execute: Code,
  websearch: Globe,
  skill: GraduationCap,
  question: HelpCircle,
  invalid: X,
  other: LayoutGrid,
} satisfies Record<string, MessageContentIcon>

const aliases: Record<string, keyof typeof contentIcons> = {
  "apply-patch": "apply_patch",
  shell: "bash",
  subagent: "task",
  terminal: "bash",
  todo: "todowrite",
  todo_write: "todowrite",
  web_fetch: "webfetch",
}

export function getMessageContentIcon(contentKey?: string | null): MessageContentIcon {
  const normalized = contentKey?.trim().toLowerCase().replace(/^opencode_/, "") ?? ""
  const key = aliases[normalized] ?? normalized
  return contentIcons[key as keyof typeof contentIcons] ?? contentIcons.other
}
