import {render} from 'solid-js/web'
import {SourceContext,prepareSourceContext,sourceContextSettled} from './parity/source-context.fixture'
const contract=document.querySelector<HTMLTemplateElement>('#source-contract')
if(!contract?.innerHTML)throw Error('Source theme contract markup required')
await prepareSourceContext()
render(()=><SourceContext><div innerHTML={contract.innerHTML}/></SourceContext>,document.getElementById('root')!)
await sourceContextSettled()
