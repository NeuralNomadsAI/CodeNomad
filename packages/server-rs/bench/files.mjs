// Mode `files`: Files and Git routes on a rich repository (rename, gitlink, conflict, CRLF, large and binary
// files), mutations, refusals and watches; `populate` seeds every bench project, `browserFiles` is the Solid step.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"

const cli=promisify(execFile)
function gitEnv(){
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_/i.test(k)))
  return {...env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null",
    GIT_AUTHOR_DATE:"2026-01-01T00:00:00Z",GIT_COMMITTER_DATE:"2026-01-01T00:00:00Z"}
}
async function git(dir,...args){
  return (await cli("git",["-C",dir,...args],{windowsHide:true,env:gitEnv()})).stdout.trim()
}
export async function populate(dir,rich=false){
  await mkdir(dir,{recursive:true})
  if(rich) await git(dir,"init","-q","-b","main")
  await git(dir,"config","user.name","CodeNomad fixture")
  await git(dir,"config","user.email","fixture@example.invalid")
  await git(dir,"config","core.autocrlf","false")
  await mkdir(path.join(dir,"nested"))
  const put=(name,value)=>writeFile(path.join(dir,name),value)
  await put("Editable.txt","Original CodeNomad text.\n")
  await put("nested/étude.txt","Écriture lisible.\n")
  await put("binary.bin",Buffer.from([0,255,1,2,3]))
  await put(".gitattributes","*.txt -text\n")
  await put("whitespace.txt","left  right\nend \n")
  await put("line-ending.txt","alpha\nbeta\n")
  // Large enough to exercise real bounded readers without freezing Monaco.
  const big=Array.from({length:21500},(_,i)=>`${i}: ${"CodeNomad content ".repeat(3)}\n`).join("")
  await put("large.txt",big)
  await git(dir,"add","--",".")
  await git(dir,"commit","-qm","Initial fixture")
  await put("large.txt",big.replaceAll("CodeNomad","Prototype"))
  if(rich){
    await rename(path.join(dir,"Editable.txt"),path.join(dir,"Renamed.txt"))
    await git(dir,"add","-A","--","Editable.txt","Renamed.txt")
    await put("binary.bin",Buffer.from([0,0,255,255]))
    await put("whitespace.txt"," left right \nend\n")
    await put("line-ending.txt","alpha\r\nbeta\r\n")
    await put("untracked.txt","one\ntwo\n")
    const commit=await git(dir,"rev-parse","HEAD")
    await git(dir,"update-index","--add","--cacheinfo",`160000,${commit},submodule`)
    await git(dir,"commit","-qm","Rename and gitlink")
    // An unmerged index entry without touching the existing working tree or
    // invoking merge strategy, editor or hook.
    const blob=async value=>{
      const file=path.join(dir,"conflict.txt")
      await writeFile(file,value)
      return git(dir,"hash-object","-w",file)
    }
    const conflict=[await blob("base\n"),await blob("ours\n"),await blob("theirs\n")]
    const spec=conflict.map((sha,i)=>`100644 ${sha} ${i+1}\tconflict.txt`).join("\n")+"\n"
    const child=spawn("git",["-C",dir,"update-index","--index-info"],{windowsHide:true,env:gitEnv()})
    child.stdin.end(spec)
    await new Promise((resolve,reject)=>child.once("close",status=>status===0?resolve():reject(Error("Could not seed conflict fixture"))))
    await put("staged.txt","new staged\n")
    await git(dir,"add","--","staged.txt")
    await put("ignored.large",Buffer.alloc(5*1024*1024+1,97))
    await writeFile(path.join(dir,".git/info/exclude"),"ignored.large\n")
  }
}
const json=(data,method="POST")=>({method,headers:{"content-type":"application/json"},body:JSON.stringify(data)})
const q=data=>new URLSearchParams(data)
export async function pair(...hosts){
  const rows=[]
  const cleanup=[]
  const report={rows}
  try{
    for(const host of hosts){
      const open=async name=>{
        const r=await host.call("/api/workspaces",json({path:name}))
        assert.equal(r.status,201,await r.clone().text())
        return r.json()
      }
      const rich=await open("Rich"), none=await open("No Repository")
      host.base=`/api/workspaces/${rich.id}`
      host.none=`/api/workspaces/${none.id}`
      host.root=rich.path
      host.nonePath=none.path
      cleanup.push(()=>host.call(host.base,{method:"DELETE"}),()=>host.call(host.none,{method:"DELETE"}))
    }
    async function check(name,route,{init,project="base",codes=[200,200],normalize=x=>x,equal=true}={}){
      const responses=await Promise.all(hosts.map(h=>h.call(h[project]+(typeof route==="function"?route(h):route),init)))
      const statuses=responses.map(r=>r.status)
      const bodies=await Promise.all(responses.map(r=>r.text().then(t=>{try{return JSON.parse(t)}catch{return t}})))
      rows.push({name,statuses})
      assert.deepEqual(statuses,codes,`${name}: ${JSON.stringify(bodies.map(x=>typeof x==="string"?x.slice(0,160):x?.error))}`)
      if(equal) {
        const comparable=bodies.map(normalize)
        assert.deepEqual(comparable[1],comparable[0],name)
        rows.at(-1).sameBody=true
      }
      return bodies
    }
    const g="/worktrees/root/git-"
    const list=entries=>entries.filter(e=>e.name!==".git").map(({name,path,type,size})=>({name,path,type,size})).sort((a,b)=>a.name.localeCompare(b.name))
    const content=({workspaceId,version,...body})=>body
    const states=values=>values.slice().sort((a,b)=>a.path.localeCompare(b.path))
    await check("root tree","/files",{normalize:list})
    await check("nested Unicode listing","/files?path=nested",{normalize:list})
    await check("Unicode UTF-8",`/files/content?${q({path:"nested/étude.txt"})}`,{normalize:content})
    await check("binary bytes","/files/preview?path=binary.bin",{normalize:content})
    await check("large file","/files/preview?path=large.txt",{normalize:content})
    await check("5 MiB preview limit","/files/preview?path=ignored.large",{codes:[400,400]})
    const [status]=await check("status with staged, unmerged and untracked",g+"status",{normalize:states})
    assert(status.some(e=>e.path==="conflict.txt"&&(e.stagedStatus==="unmerged"||e.unstagedStatus==="unmerged")))
    await check("whitespace and CRLF filter",g+"status?hideWhitespace=1",{normalize:states})
    await check("working tree binary diff",g+"diff?path=binary.bin&scope=unstaged")
    await check("large text diff",g+"diff?path=large.txt&scope=unstaged")
    await check("staged new file diff",g+"diff?path=staged.txt&scope=staged")
    const [history]=await check("history",g+"history")
    await check("stable continuation",g+`history?offset=1&head=${history.head}`)
    await check("renamed path and gitlink in commit",g+`history/${history.head}`)
    await check("rename commit diff",g+`history/${history.head}?path=Renamed.txt`)
    await check("gitlink commit diff",g+`history/${history.head}?path=submodule`)
    await check("worktree with no repository",g+"status",{project:"none",codes:[400,400]})
    await check("lexical parent refusal","/files/preview?path=../fixture.txt",{codes:[400,400],equal:false})
    await check("foreign browsing root",h=>`/files?${q({directory:path.dirname(h.root)})}`,{codes:[400,400],equal:false})
    await check("Git invalid relative path",g+"diff?path=../fixture.txt&scope=unstaged",{codes:[400,400],equal:false})
    await check("Git init wrong directory",h=>"/git-init",{project:"none",init:json({directory:path.dirname(hosts[0].nonePath)}),codes:[409,409],equal:false})
    await check("stage fixture",g+"stage",{init:json({paths:["untracked.txt"]})})
    await check("unstage fixture",g+"unstage",{init:json({paths:["untracked.txt"]})})
    await check("commit refuses unmerged index",g+"commit",{init:json({message:"Must not commit a conflict"}),codes:[409,409],equal:false})
    await check("stage conflict resolution",g+"stage",{init:json({paths:["conflict.txt"]})})
    const commits=await check("commit resolved index",g+"commit",{init:json({message:"Resolve fixture index"}),normalize:({commitSha,...body})=>body})
    for(const {commitSha} of commits)assert.match(commitSha,/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    const initStatuses=[]
    for(const h of hosts){
      const ok=await h.call(`${h.none}/git-init`,json({directory:h.nonePath}))
      const body=await ok.json()
      initStatuses.push(ok.status)
      rows.push({name:"Git init exact directory",backend:h===hosts[0]?"typescript":"rust",status:ok.status,code:body.code})
      if(ok.status===409) assert.equal(body.code,"git_init_directory_mismatch")
      else assert.equal(ok.status,200,JSON.stringify(body))
    }
    assert.equal(initStatuses[0],initStatuses[1])
    if(initStatuses[0]===200){
      await check("unborn history",g+"history",{project:"none",normalize:({branch,...body})=>body})
      for (const h of hosts){
        const repeat=await h.call(`${h.none}/git-init`,json({directory:h.nonePath}))
        assert.equal(repeat.status,409)
        assert.equal((await repeat.json()).code,"git_init_repository_exists")
      }
    }
    const rs=hosts[1]
    await writeFile(path.join(rs.root,"large.txt"),Buffer.alloc(2*1024*1024+1,97))
    const cappedDiff=await rs.call(rs.base+g+"diff?path=large.txt&scope=unstaged")
    assert.equal(cappedDiff.status,400)
    report.diffLimit=cappedDiff.status
    const before=await (await rs.call(`${rs.base}/files/preview?path=Renamed.txt`)).json()
    assert.match(before.version,/^"[a-f0-9]{64}"$/)
    await writeFile(path.join(rs.root,"Renamed.txt"),"external edit\n")
    const stale=await rs.call(`${rs.base}/files/content?path=Renamed.txt`,json({contents:"stale",expectedVersion:before.version},"PUT"))
    assert.equal(stale.status,409)
    assert.equal(await readFile(path.join(rs.root,"Renamed.txt"),"utf8"),"external edit\n")
    report.staleVersion=stale.status
    for(const forbidden of ["NUL.txt","\\\\invalid.invalid\\share\\fixture.txt",".git/config"]){
      const bad=await rs.call(`${rs.base}/files/preview?${q({path:forbidden})}`)
      assert.equal(bad.status,400)
    }
    report.reservedAndUncRefused=true
    const sibling=rs.nonePath
    await writeFile(path.join(sibling,"fixture-only.txt"),"Unrelated synthetic workspace\n")
    await symlink(sibling,path.join(rs.root,"external-directory"),process.platform==="win32"?"junction":"dir")
    // Outward links are followed like the TS server (browser.ts).
    const listed=await rs.call(rs.base+"/files?path=external-directory")
    assert.equal(listed.status,200)
    assert((await listed.json()).some(e=>e.name==="fixture-only.txt"&&e.path==="external-directory/fixture-only.txt"))
    const followed=await rs.call(rs.base+"/files/preview?path=external-directory%2Ffixture-only.txt")
    assert.equal(followed.status,200)
    assert.equal(Buffer.from((await followed.json()).contents,"base64").toString(),"Unrelated synthetic workspace\n")
    report.outwardDirectoryFollowed=true
    if(process.platform==="win32"){
      const caseAlias=await rs.call(`${rs.base}/files/preview?${q({path:"rEnAmEd.TxT"})}`)
      assert.equal(caseAlias.status,200)
      assert.equal(Buffer.from((await caseAlias.json()).contents,"base64").toString(),"external edit\n")
      report.windowsCaseAlias=true
    }
    for(const host of hosts){
      const controller=new AbortController()
      const s=await host.call(`/api/events?clientId=files&connectionId=${randomUUID()}`,{signal:controller.signal})
      assert.equal(s.status,200)
      const reader=s.body.getReader()
      try{
        const sub=await host.call(`${host.base}/files?path=nested`)
        assert.equal(sub.status,200)
        await sub.text()
        await writeFile(path.join(host.root,"nested/watch.txt"),"watch fixture")
        let data="", timer
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Watch did not publish the listed directory")),5000)})
        try{while(!data.includes('"path":"nested"')){
          const next=await Promise.race([reader.read(),timeout]);assert(!next.done);data+=new TextDecoder().decode(next.value)
        }}finally{clearTimeout(timer)}
        assert.match(data,/"type":"workspace.filesChanged"/)
      }finally{controller.abort();await reader.cancel().catch(()=>{})}
    }
    report.watch={typescript:true,rust:true}
    return report
  }finally{for(const close of cleanup)await close()}
}

export async function browserFiles(page,capture,project){
  const remote=route=>response=>new URL(response.url()).pathname.startsWith("/api/backends/rust2/")&&new URL(response.url()).pathname.endsWith(route)
  async function receive(route,action){
    const [response]=await Promise.all([page.waitForResponse(r=>remote(route)(r)&&r.request().method()==="GET"),action()])
    assert.equal(response.status(),200,`GET ${route}: ${response.status()}`)
    return response
  }
  const mode=name=>page.getByRole("button",{name,exact:true})
  const eye=(row,name)=>page.locator(row).filter({hasText:name,visible:true}).getByRole("button",{name:new RegExp(` · ${name.replace(".","\\.")}$`)}).first()
  await page.getByRole("tab",{name:"Files",exact:true}).click()
  await page.locator(".workspace-tree-row").filter({hasText:"Editable.txt",visible:true}).waitFor()
  await writeFile(path.join(project,"watch-live.txt"),"Created outside the browser\n")
  await page.getByRole("treeitem",{name:"watch-live.txt",exact:true}).filter({visible:true}).waitFor({timeout:12000})
  await capture(page,"11-arbre-fichiers")
  const preview=await receive("/files/preview",()=>eye(".workspace-tree-row","large.txt").click())
  assert(Buffer.from((await preview.json()).contents,"base64").length>1024*1024)
  await page.locator(".monaco-editor").filter({visible:true}).first().waitFor()
  await capture(page,"12-monaco-grand-fichier")
  await receive("/git-status",()=>mode("Changes").click())
  const diff=await receive("/git-diff",()=>eye(".git-panel-file-row","large.txt").click())
  const text=await diff.json()
  assert(text.before.length>1024*1024&&text.after.length>1024*1024)
  await page.locator(".monaco-diff-editor").filter({visible:true}).waitFor()
  await capture(page,"13-changements-grand-diff")
  return {workspace:true,largeFile:true,largeDiff:true,watch:true}
}
