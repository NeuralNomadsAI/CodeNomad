import assert from "node:assert/strict"

const far = Date.UTC(2090, 0, 1)
const jwt = claims => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`
const oauth = (methodID, metadata, access = "fixture-access-not-returned") => ({
  type: "oauth", methodID, access, expires: far, refresh: "fixture-refresh-not-returned", metadata,
})

export async function run({ call, fixture, folder, other }) {
  const opened = await call("/api/workspaces", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({path:folder}),
  })
  assert.equal(opened.status,201)
  const workspace = await opened.json()
  const root = `/api/workspaces/${workspace.id}`
  const read = (integration, directory = workspace.location.directory) =>
    call(`${root}/provider-accounts/${integration}?${new URLSearchParams({ directory })}`)
  const response = async integration => {
    const result = await read(integration)
    assert.equal(result.status,200,`${integration}: ${await result.clone().text()}`)
    assert.equal(result.headers.get("cache-control"),"no-store")
    return result.json()
  }
  const expected = (logins = {}, supported = false) => ({ supported, enabled:false, logins })
  const remove = []
  const create = async (integrationID, label, value, activate = false) => {
    const entry = await fixture.client.credential.create({ integrationID, label, value, activate })
    remove.push(entry.id)
    return entry.id
  }
  try {
    const codex = await create("openai","default",oauth("chatgpt-browser",{},jwt({
      exp:far/1000,"https://api.openai.com/auth":{chatgpt_account_id:"fixture-secret-account"},
      "https://api.openai.com/profile":{email:"codex@example.test"},
    })),true)
    await create("openai","Work alias",oauth("chatgpt-headless",{email:"alias@example.test",accountID:"fixture-secret-account"}))
    assert.deepEqual(await response("openai"),expected({[codex]:"codex@example.test"},true))
    const consoleAccount = await create("opencode","default",oauth("device",{email:"  console@example.test  "}),true)
    assert.deepEqual(await response("opencode"),expected({[consoleAccount]:"console@example.test"}))
    const claude = await create("anthropic","default",oauth("oauth",{email:"claude@example.test"}),true)
    await create("anthropic","default",oauth("oauth",{email:"not an email@example.test"}))
    assert.deepEqual(await response("anthropic"),expected({[claude]:"claude@example.test"},true))
    assert.deepEqual(await response("unsupported-fixture"),expected())
    const denied = await read("openai",other)
    assert.equal(denied.status,403)
    assert.equal(denied.headers.get("cache-control"),"no-store")
    assert.deepEqual(await denied.json(),{error:"Location does not belong to workspace"})
    assert.equal((await call(`${root}/provider-accounts/openai`)).status,400)
    return {codex:true,console:true,anthropic:true,aliasPreserved:true,unownedRejected:true}
  } finally {
    for(const credentialID of remove.reverse()) await fixture.client.credential.remove({credentialID})
    await call(root,{method:"DELETE"})
  }
}
