import { NativeParent } from '../../../server/src/native-parent'
import { installShutdownStdinHandler } from '../../../server/src/shutdown'
import { writeFileSync } from 'node:fs'
const parent=new NativeParent(process.stdout,true)
installShutdownStdinHandler(process.stdin,async()=>{},line=>parent.handleLine(line))
const [base,output]=process.argv.slice(2)
const request=(method:string,input:object={})=>parent.request<any>(method,{sessionID:'fixture-session',...input},20000)
async function main(){
 await request('browser.execute',{command:{action:'open',url:base+'/mobile'}})
 await request('fixture.mobile-init',{url:base+'/mobile'})
 const rows=[]
 for(const [name,settings] of Object.entries({baseline:{},zoom:{zoom:1.5},density:{dpr:2.75},combined:{zoom:1.5,dpr:2.75},fixed:{mode:1,cssWidth:390,cssHeight:844},viewScale:{mode:2},mobileUA:{ua:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'}})) {
  await request('fixture.mobile-size',{width:600,height:400})
  const native=await request('fixture.mobile-trial',settings)
  const row={name,native,guest:await request('fixture.mobile-probe'),primary:await request('fixture.mobile-probe',{target:'primary'}),other:await request('fixture.mobile-probe',{target:'other'})};rows.push(row)
 }
 await request('fixture.mobile-trial',{})
 for(const phase of [0,1,2]) await request('fixture.mobile-touch',{phase})
 rows.push({name:'touch',guest:await request('fixture.mobile-probe')})
 writeFileSync(output+'/mobile-trial.json',JSON.stringify(rows,null,2));console.error(JSON.stringify(rows));parent.close();process.exit(0)
}
main().catch(e=>{console.error(e);parent.close();process.exit(1)})
