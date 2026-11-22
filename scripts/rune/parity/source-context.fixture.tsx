import {type JSX} from 'solid-js'
import {ConfigProvider,updatePreferences,setThemePreference,useConfig} from '../../../packages/ui/src/stores/preferences'
import {I18nProvider,preloadLocaleMessages} from '../../../packages/ui/src/lib/i18n'
import {ThemeProvider} from '../../../packages/ui/src/lib/theme'
import '../../../packages/ui/src/index.css'

export const sourceOptions=()=>{const q=new URL(location.href).searchParams;return {theme:q.get('theme')==='dark'?'dark' as const:'light' as const,locale:q.get('locale')==='he'||q.get('rtl')==='true'?'he' as const:'en' as const,provider:q.get('provider')!=='false'}}
export async function prepareSourceContext(){
 const {theme,locale}=sourceOptions()
 if(!await updatePreferences({locale}))throw Error('Synthetic locale update failed')
 await setThemePreference(theme)
 await preloadLocaleMessages(locale)
 // The CSS-only control retains the same explicit appearance without mounting the product provider.
 document.documentElement.dataset.theme=theme
}
function Metadata(props:{children:JSX.Element}){
 const config=useConfig(),options=sourceOptions()
 Object.assign(window,{runeSourceContext:{snapshot:()=>({kind:options.provider?'product-default':'css-only-control',theme:options.theme,locale:options.locale,mode:config.themePreference(),palette:config.getAppearancePalette(options.theme),dir:document.documentElement.dir})}})
 return props.children
}
export function SourceContext(props:{children:JSX.Element}){
 return <ConfigProvider><I18nProvider>{sourceOptions().provider?<ThemeProvider><Metadata>{props.children}</Metadata></ThemeProvider>:<Metadata>{props.children}</Metadata>}</I18nProvider></ConfigProvider>
}
export async function sourceContextSettled(){
 await document.fonts.ready
 await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
 ;(window as any).runeSourceContext.ready=true
}
