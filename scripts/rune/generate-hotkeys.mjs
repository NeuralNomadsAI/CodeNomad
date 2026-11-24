import {generated} from './generate-common.mjs'
import {defaultHotkeyBindings, getHotkeyDefinitions} from '../../packages/ui/src/lib/hotkey-definitions.ts'

const rows = getHotkeyDefinitions().map(({id, labelKey, labelParams, scope}) => ({
  id, labelKey, scope, ...(labelParams && {labelParams}),
  defaults: [false, true].flatMap(mac => [true, false].map(send => defaultHotkeyBindings(id, send, mac))),
}))
await generated('assets/hotkeys.json', `[\n${rows.map(row => `  ${JSON.stringify(row)}`).join(',\n')}\n]\n`)
