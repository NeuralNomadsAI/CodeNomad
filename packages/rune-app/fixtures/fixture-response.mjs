import assert from 'node:assert/strict'
export function responseFor(turn, prompt) {
  return `fn main() {\n    println!(${JSON.stringify(`Rune · tour ${turn}: ${prompt}`)});\n}`
}
// Native text ordinals count text fragments, independently of intervening tools.
export function textStream(reply,emit,ordinal=0) {
  const part={type:'text',text:''}
  const texts=reply.content.filter(p=>p.type==='text')
  if(ordinal===0&&texts.length===1&&!texts[0].text)reply.content[reply.content.indexOf(texts[0])]=part
  else {assert.equal(texts.length,ordinal);reply.content.push(part)}
  const identity={assistantMessageID:reply.id,ordinal}
  emit('session.text.started',identity)
  return {
    append(delta){assert(!part.native);part.text+=delta;emit('session.text.delta',{...identity,delta})},
    close(){assert(!part.native);part.native={itemID:`${reply.id}-text-${ordinal}`};emit('session.text.ended',{...identity,text:part.text})},
  }
}
