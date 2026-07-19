import { tool } from "@opencode-ai/plugin/tool"
import { createCodeNomadRequester, type CodeNomadConfig } from "./request.js"

type GitHubOp =
  | "add_reaction"
  | "add_pr_review_comment_reaction"
  | "post_issue_comment"
  | "publish_pr"
  | "list_issue_comments"
  | "list_pr_review_comments"

export function createGitHubTool(config: CodeNomadConfig, options: { directory: string }) {
  const requester = createCodeNomadRequester(config)
  const request = async <T>(payload: any): Promise<T> => requester.requestJson<T>("/integrations/github", {
    method: "POST",
    body: JSON.stringify(payload),
  })

  return tool({
    description: "Perform GitHub operations for this workspace's repo.",
    args: {
      op: tool.schema
        .enum([
          "add_reaction",
          "add_pr_review_comment_reaction",
          "post_issue_comment",
          "publish_pr",
          "list_issue_comments",
          "list_pr_review_comments",
        ])
        .describe("Operation"),
      commentId: tool.schema.number().optional().describe("Comment ID for reaction operations"),
      content: tool.schema
        .enum(["eyes", "rocket", "+1", "-1", "laugh", "confused", "heart", "hooray"])
        .optional()
        .describe("Reaction content"),
      issueNumber: tool.schema.number().optional().describe("Issue number for issue comment operations"),
      prNumber: tool.schema.number().optional().describe("PR number for review comment listing"),
      since: tool.schema.string().optional().describe("ISO timestamp for incremental comment listing"),
      body: tool.schema.string().optional().describe("Comment or PR body"),
      title: tool.schema.string().optional().describe("PR title for publish_pr"),
      base: tool.schema.string().optional().describe("PR base branch for publish_pr"),
      draft: tool.schema.boolean().optional().describe("Create a draft PR"),
    },
    async execute(args: {
      op: GitHubOp
      commentId?: number
      content?: string
      issueNumber?: number
      prNumber?: number
      since?: string
      body?: string
      title?: string
      base?: string
      draft?: boolean
    }) {
      if (args.op === "add_reaction") {
        if (!args.commentId || !args.content) return stringify({ ok: false, op: args.op, error: "commentId and content are required" })
        return stringify(await request({ op: args.op, commentId: args.commentId, content: args.content }))
      }

      if (args.op === "add_pr_review_comment_reaction") {
        if (!args.commentId || !args.content) return stringify({ ok: false, op: args.op, error: "commentId and content are required" })
        return stringify(await request({ op: args.op, commentId: args.commentId, content: args.content }))
      }

      if (args.op === "post_issue_comment") {
        if (!args.issueNumber || !args.body) return stringify({ ok: false, op: args.op, error: "issueNumber and body are required" })
        return stringify(await request({ op: args.op, issueNumber: args.issueNumber, body: args.body }))
      }

      if (args.op === "publish_pr") {
        if (!args.title) return stringify({ ok: false, op: args.op, error: "title is required" })
        return stringify(await request({
          op: args.op,
          directory: options.directory,
          title: args.title,
          body: args.body,
          base: args.base,
          draft: args.draft,
        }))
      }

      if (args.op === "list_issue_comments") {
        if (!args.issueNumber) return stringify({ ok: false, op: args.op, error: "issueNumber is required" })
        return stringify(await request({ op: args.op, issueNumber: args.issueNumber, ...(args.since ? { since: args.since } : {}) }))
      }

      if (args.op === "list_pr_review_comments") {
        if (!args.prNumber) return stringify({ ok: false, op: args.op, error: "prNumber is required" })
        return stringify(await request({ op: args.op, prNumber: args.prNumber, ...(args.since ? { since: args.since } : {}) }))
      }

      return "Unknown op"
    },
  })
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
