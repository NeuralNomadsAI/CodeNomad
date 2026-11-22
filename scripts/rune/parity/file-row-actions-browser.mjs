import {chromium} from 'playwright'
import {borrowFixture} from '../../../packages/ui/tests/browser/fixture-borrow.ts'
import {armFixtureNavigationBudget} from '../../../packages/ui/tests/browser/fixture-navigation-budget.ts'
export async function startFileActionsBrowser(){
  const fixture=await borrowFixture({name:'rune-file-actions',routes:[{path:'/file-actions',html:'<html><body style="margin:0"><div id="root"></div><script type="module" src="/tests/browser/fixtures/file-row-actions.tsx"></script></body></html>'}]})
  const browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined})
  armFixtureNavigationBudget(browser)
  return {server:fixture,browser,url:fixture.url,origin:new URL(fixture.url).origin}
}
