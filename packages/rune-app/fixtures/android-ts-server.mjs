import assert from 'node:assert/strict'
import {createServer} from 'node:net'
import path from 'node:path'

export async function androidTsServer({root,profile,project,ui,env}) {
  const socket=createServer()
  await new Promise((resolve,reject)=>socket.once('error',reject).listen(0,'127.0.0.1',resolve))
  const {port}=socket.address()
  await new Promise(resolve=>socket.close(resolve))
  const host='rune-server.fixture.test'
  const https=`https://${host}:${port}`
  const config=path.join(profile,'identity.data','config.yaml')
  Object.assign(env,{CODENOMAD_SERVER_PASSWORD:env.CNRS_SERVER_PASSWORD,
    CNRS_FIXTURE_PID:String(process.pid),CODENOMAD_ALLOWED_ORIGINS:https})
  delete env.CODENOMAD_REMOTE_CONTROL
  return {https,
    command:process.execPath,args:[path.join(root,'packages/server-rs/bench/ts-server.mjs'),
      '--host','127.0.0.1','--http','true','--http-port','0','--https','true','--https-port',String(port),
      '--tlsSANs',host,'--config',config,'--ui-dir',ui,'--ui-no-update','--workspace-root',path.dirname(project)],
    ready(log){
      const local=/^Local Connection URL : (http:\/\/127\.0\.0\.1:\d+)\s*$/m.exec(log)?.[1]
      if(local&&log.includes('Remote Connection URL :')){
        assert(log.includes(`https://localhost:${port}`),'TypeScript must bind the pinned HTTPS port')
        return local
      }
    },
  }
}
