import assert from 'node:assert/strict'
export const code='fn main() {\n    println!("Rune · Code Nomad");\n}'
export class FixtureStore {
  constructor(count=10000,assistantProfile) {
    this.assistantProfile=assistantProfile
    this.rows=Array.from({length:count},(_,i)=>({id:`message-${String(i).padStart(5,'0')}`,type:'assistant',time:{created:i,completed:i+1},
      content:[{type:'text',text:i===count-1?code:`Synthetic message ${i}\nété · 日本語 · 🦀`}]}))
  }
  window(target) {
    const at=this.rows.findIndex(row=>row.id===target.messageID)
    if(target.messageID&&at<0)return {status:'blocked',reason:'anchor_missing'}
    let start=0,end=this.rows.length
    switch(target.kind){
      case 'latest': start=Math.max(0,end-200);break
      case 'oldest': end=Math.min(end,200);break
      case 'around': start=Math.max(0,at-80);end=Math.min(end,at+120);break
      case 'before': start=Math.max(0,at-184);end=Math.min(end,at+16);break
      case 'after': start=Math.max(0,at-15);end=Math.min(end,at+185);break
      default: assert.fail('unsupported navigation target')
    }
    const messages=this.rows.slice(start,end)
    return structuredClone({status:'window',messages,older:start>0?{kind:'before',messageID:messages[0].id}:null,
      newer:end<this.rows.length?{kind:'after',messageID:messages.at(-1).id}:null,latest:end===this.rows.length,resume:target})
  }
  append(type,body,completed=true) {
    const i=this.rows.length
    const row={id:`message-${String(i).padStart(5,'0')}`,type,time:{created:Date.now()},...(type==='user'?{text:body}:{...this.assistantProfile,content:[{type:'text',text:body}]})}
    if(completed)row.time.completed=Date.now()
    this.rows.push(row);return row
  }
}
