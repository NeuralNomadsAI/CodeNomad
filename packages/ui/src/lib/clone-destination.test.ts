import assert from "node:assert/strict"
import { it } from "node:test"

import { parentDirectory, repositoryFolderName, suggestCloneDestination } from "./clone-destination.ts"

it("names the clone folder like git clone", () => {
  assert.equal(repositoryFolderName("https://github.com/pascalandr/open-design"), "open-design")
  assert.equal(repositoryFolderName(" https://github.com/user/repo.git/ "), "repo")
  assert.equal(repositoryFolderName("git@github.com:user/repo.git"), "repo")
  assert.equal(repositoryFolderName("https://host/user/repo?tab=readme#top"), "repo")
  assert.equal(repositoryFolderName("D:\\src\\repo\\.git"), "repo")
  assert.equal(repositoryFolderName("D:\\src\\C#-examples"), "C#-examples")
  assert.equal(repositoryFolderName("/srv/repo.git/.git/"), "repo")
  assert.equal(repositoryFolderName(""), "")
})

it("remembers the folder above a clone, keeping roots", () => {
  assert.equal(parentDirectory("D:\\open-design"), "D:\\")
  assert.equal(parentDirectory("D:\\repos\\open-design\\"), "D:\\repos")
  assert.equal(parentDirectory("/home/me/src/repo"), "/home/me/src")
  assert.equal(parentDirectory("/repo"), "/")
  assert.equal(parentDirectory("\\\\server\\share\\repo"), "\\\\server\\share")
  assert.equal(parentDirectory("\\\\server\\share"), "\\\\server\\share\\")
  assert.equal(suggestCloneDestination(parentDirectory("\\\\server\\share"), "https://host/user/repo"), "\\\\server\\share\\repo")
})

it("suggests the repository's folder inside the remembered parent", () => {
  assert.equal(suggestCloneDestination("D:\\", "https://github.com/pascalandr/open-design"), "D:\\open-design")
  assert.equal(suggestCloneDestination("D:\\repos", "https://github.com/user/repo.git"), "D:\\repos\\repo")
  assert.equal(suggestCloneDestination("/home/me/src", "git@github.com:user/repo.git"), "/home/me/src/repo")
  assert.equal(suggestCloneDestination(undefined, "https://github.com/user/repo"), "")
  assert.equal(suggestCloneDestination("/home/me", ""), "")
})
