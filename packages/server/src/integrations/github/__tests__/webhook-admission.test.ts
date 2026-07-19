import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { hasGitHubMentionTrigger, isGitHubActorAllowed } from "../webhook-admission"

describe("GitHub webhook admission helpers", () => {
  describe("isGitHubActorAllowed", () => {
    it("allows explicit allowedUsers case-insensitively", () => {
      assert.equal(isGitHubActorAllowed({ allowedUsers: ["Alice"], allowedAuthorAssociations: [] }, { login: "alice", authorAssociation: "NONE" }), true)
    })

    it("allows allowedAuthorAssociations", () => {
      assert.equal(isGitHubActorAllowed({ allowedUsers: [], allowedAuthorAssociations: ["OWNER"] }, { login: "someone", authorAssociation: "OWNER" }), true)
    })

    it("falls back to OWNER/COLLABORATOR when no associations configured", () => {
      assert.equal(isGitHubActorAllowed({ allowedUsers: [], allowedAuthorAssociations: [] }, { login: "x", authorAssociation: "OWNER" }), true)
      assert.equal(isGitHubActorAllowed({ allowedUsers: [], allowedAuthorAssociations: [] }, { login: "x", authorAssociation: "COLLABORATOR" }), true)
      assert.equal(isGitHubActorAllowed({ allowedUsers: [], allowedAuthorAssociations: [] }, { login: "x", authorAssociation: "MEMBER" }), false)
    })

    it("denies when association missing and user not allowed", () => {
      assert.equal(isGitHubActorAllowed({ allowedUsers: [], allowedAuthorAssociations: ["OWNER"] }, { login: "x" }), false)
    })

    it("allows all actors when allowAllActors is true", () => {
      assert.equal(isGitHubActorAllowed({ allowedUsers: [], allowedAuthorAssociations: [], allowAllActors: true }, { login: "someone" }), true)
    })

    it("denies bots when denyBots is true", () => {
      assert.equal(isGitHubActorAllowed({ allowedUsers: [], allowedAuthorAssociations: [], allowAllActors: true, denyBots: true }, { login: "bot", authorAssociation: "OWNER", type: "Bot" }), false)
    })
  })

  describe("hasGitHubMentionTrigger", () => {
    it("matches default @codenomad when no handles configured", () => {
      assert.equal(hasGitHubMentionTrigger({ text: "please @codenomad do it" }), true)
      assert.equal(hasGitHubMentionTrigger({ text: "@codenomad, hello" }), true)
      assert.equal(hasGitHubMentionTrigger({ text: "no mention here" }), false)
    })

    it("matches configured mentionHandle", () => {
      assert.equal(hasGitHubMentionTrigger({ text: "hi @robot", mentionHandle: "robot" }), true)
      assert.equal(hasGitHubMentionTrigger({ text: "hi @RoBoT", mentionHandle: "robot" }), true)
      assert.equal(hasGitHubMentionTrigger({ text: "hi @codenomad", mentionHandle: "robot" }), false)
    })

    it("matches botLogin with and without [bot] suffix", () => {
      assert.equal(hasGitHubMentionTrigger({ text: "hi @myapp", botLogin: "myapp[bot]" }), true)
      assert.equal(hasGitHubMentionTrigger({ text: "hi @myapp[bot]", botLogin: "myapp[bot]" }), true)
    })

    it("does not match inside an email", () => {
      assert.equal(hasGitHubMentionTrigger({ text: "contact test@codenomad.com" }), false)
    })
  })
})
