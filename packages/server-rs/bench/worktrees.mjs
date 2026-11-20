// Mode `http`: linked worktrees (create, move a session, evacuation on delete, dirty refusal), owned paths,
// VCS reads on both servers; `browserWorktrees` is the Solid step.
import assert from "node:assert/strict"
import { stat,symlink,writeFile,unlink,rmdir } from "node:fs/promises"
import path from "node:path"

const post=value=>({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)})
export async function pair(ts,rs){
  const proof=[]
  for(const [name,host,folder] of [["ts",ts.call,"Local Project"],["rust",rs.call,"Rust Project"]]){
    const creation=await host("/api/workspaces",post({path:folder}))
    assert.equal(creation.status,201,await creation.clone().text())
    const w=await creation.json()
    const base=`/api/workspaces/${w.id}`,tree=`${base}/worktrees`
    const call=async(route,init,status)=>{
      const res=await host(route,init)
      const text=await res.text()
      proof.push({backend:name,route:route.replace(w.id,":id"),status:res.status})
      assert.equal(res.status,status,`${name}: ${route}: ${text.slice(0,2000)}`)
      return text?JSON.parse(text):null
    }
    const inventory=await call(tree+"?fresh=true",{},200)
    assert.equal(inventory.worktrees[0].slug,"root")
    assert.equal((await host(tree,post({slug:inventory.worktrees[0].branch}))).status,400)
    const added=await call(tree,post({slug:"fixture-placement",fromSlug:"root"}),201)
    assert.equal(added.branch,"fixture-placement")
    assert.equal(added.head,inventory.worktrees[0].head)
    assert.equal((await host(tree,post({slug:"fixture-placement"}))).status,400)
    const session=(await call(`${w.proxyPath}/api/session`,post({title:"Worktree HTTP fixture"}),200)).data
    await call(`${w.proxyPath}/api/vcs/status`,{},200)
    const moved=await call(`${base}/sessions/${session.id}/worktree`,post({worktreeSlug:added.slug}),200)
    assert.deepEqual(moved.sessionIds,[session.id])
    const returned=await call(`${w.proxyPath}/api/session/${session.id}`,{},200)
    assert.equal((returned.data??returned).location.directory,added.serviceDirectory)
    const linked=await call("/api/workspaces",post({path:added.directory}),201)
    const loaded=await call(`/api/workspaces/${linked.id}/worktrees?fresh=true`,{},200)
    assert.equal(loaded.worktrees[0].directory,added.directory)
    assert.equal(loaded.defaultDirectory,inventory.defaultDirectory)
    assert(loaded.worktrees.some(t=>t.directory===w.path&&t.removable===false))
    await call(`/api/workspaces/${linked.id}`,{method:"DELETE"},204)
    const nested=await call("/api/workspaces",post({path:path.join(w.path,"nested")}),201)
    const mirror=await call(`/api/workspaces/${nested.id}/worktrees?fresh=true`,{},200)
    assert(mirror.worktrees.some(t=>path.resolve(t.directory)===path.join(added.directory,"nested")))
    await call(`/api/workspaces/${nested.id}`,{method:"DELETE"},204)
    if(name==="rust") await call(`${tree}/${added.slug}?force=true`,{method:"DELETE"},400)
    const dirty=path.join(added.directory,"local-only.txt")
    await writeFile(dirty,"A dirty checkout is not disposable.\n")
    try{await call(`${tree}/${added.slug}`,{method:"DELETE"},409)}
    finally{await unlink(dirty)}
    await call(`${tree}/${added.slug}`,{method:"DELETE"},204)
    const evacuated=await call(`${w.proxyPath}/api/session/${session.id}`,{},200)
    assert.equal((evacuated.data??evacuated).location.directory,inventory.worktrees[0].serviceDirectory)
    await assert.rejects(stat(added.directory),{code:"ENOENT"})
    for(const p of [path.join(w.path,"Editable.txt"),"nested/../Editable.txt"]){
      const r=await host(`${base}/files/preview?${new URLSearchParams({path:p})}`)
      assert.equal(r.status,200)
      proof.push({backend:name,route:"Owned absolute or normalized path",status:r.status})
    }
    const alias=path.join(w.path,"owned-alias")
    await symlink(path.join(w.path,"nested"),alias,process.platform==="win32"?"junction":"dir")
    try{
      await call(`${base}/files/preview?${new URLSearchParams({path:"owned-alias/étude.txt"})}`,{},200)
    }finally{await (process.platform==="win32"?rmdir(alias):unlink(alias))}
    await call(base,{method:"DELETE"},204)
  }
  return proof
}

export async function browserWorktrees(page,capture){
  const branch="browser-worktree"
  const trigger=page.locator("button.selector-trigger").filter({hasText:/Worktree:/i}).filter({visible:true}).first()
  const rust=(r,method,suffix)=>r.request().method()===method&&new URL(r.url()).pathname.startsWith("/api/backends/rust2/")&&new URL(r.url()).pathname.endsWith(suffix)
  const awaitAction=async(method,suffix,status,action)=>{
    const [result]=await Promise.all([page.waitForResponse(r=>rust(r,method,suffix),{timeout:28000}),action()])
    assert.equal(result.status(),status,`${method} ${suffix}: ${await result.text()}`)
    return result
  }
  await trigger.click()
  await page.getByText("New from current branch",{exact:true}).click()
  await page.getByPlaceholder("worktree-name").fill(branch)
  const placing=page.waitForResponse(r=>rust(r,"POST","/worktree"),{timeout:30000})
  void placing.catch(()=>{})
  const created=await awaitAction("POST","/worktrees",201,()=>page.getByRole("button",{name:"Create and use worktree",exact:true}).click())
  const tree=await created.json()
  assert.equal((await placing).status(),200)
  await page.getByText(branch,{exact:true}).filter({visible:true}).first().waitFor()
  await capture(page,"15-worktree-session")
  await trigger.click()
  const row=page.locator(".worktree-selector-item").filter({hasText:branch,visible:true})
  await row.locator('button[aria-label="Delete worktree"]').click()
  const dialog=page.getByRole("dialog",{name:"Delete worktree",exact:true})
  await dialog.waitFor()
  assert.equal(await dialog.getByRole("checkbox",{name:/force/i}).count(),0)
  await awaitAction("DELETE",`/worktrees/${tree.slug}`,204,()=>dialog.getByRole("button",{name:/delete/i}).click())
  await dialog.waitFor({state:"hidden"})
  await page.getByText(`Deleted worktree ${branch}`,{exact:true}).waitFor()
  await trigger.filter({hasText:"Workspace"}).waitFor()
  await assert.rejects(stat(tree.directory),{code:"ENOENT"})
  await capture(page,"16-worktree-supprime")
  return {created:true,placed:true,removed:true,automaticEvacuation:true}
}
