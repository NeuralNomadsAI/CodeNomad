import {mkdir} from 'node:fs/promises'
import path from 'node:path'
export function fixtureSystemEnvironment(source=process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432)$/i.test(key)))
}
export async function privateEnvironment(profile) {
  const env=fixtureSystemEnvironment()
  for(const [name,relative] of Object.entries({HOME:'home',USERPROFILE:'home',APPDATA:'home/AppData/Roaming',LOCALAPPDATA:'home/AppData/Local',
    XDG_CONFIG_HOME:'xdg/config',XDG_DATA_HOME:'xdg/data',XDG_STATE_HOME:'xdg/state',XDG_CACHE_HOME:'xdg/cache',TEMP:'tmp',TMP:'tmp',TMPDIR:'tmp',CLI_CONFIG:'config'})) {
    env[name]=path.join(profile,relative);await mkdir(env[name],{recursive:true})
  }
  return {...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(profile,'empty.gitconfig'),GIT_TEMPLATE_DIR:'',GIT_CEILING_DIRECTORIES:profile,CODENOMAD_REMOTE_CONTROL:'disabled',CODENOMAD_PROFILE:'trial-rune-fixture',RUST_BACKTRACE:'1'}
}
