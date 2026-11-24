import { For, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import SessionView from '../../../src/components/session/session-view'
import { ConfigProvider } from '../../../src/stores/preferences'
import { I18nProvider } from '../../../src/lib/i18n'
import { ThemeProvider } from '../../../src/lib/theme'
import { sdkManager } from '../../../src/lib/sdk-manager'
import { addInstance } from '../../../src/stores/instances'
import { sessions, setSessions, setActiveSession, setProviders } from '../../../src/stores/session-state'
import { messageStoreBus } from '../../../src/stores/message-v2/bus'
import { sseManager } from '../../../src/lib/sse-manager'
import { loadMessages } from '../../../src/stores/session-api'
import '../../../src/index.css'

// Same HTTP/native-event seams as session.tsx. Unlike its cold remount, this
// mirrors instance-shell2's retained, display:none, isActive-fenced A/B panes.
const instanceId = 'browser-instance', model = { providerID: 'fixture', id: 'fixture' }
const [active, setActive] = createSignal('A')
let time = Date.now()
const messages = new Map(['A', 'B'].map(id => [id, Array.from({ length: 60 }, (_, i) => ({
  id: `msg_${String(i).padStart(4, '0')}_${id}`, type: 'assistant', agent: 'build', model,
  time: { created: i + 1, completed: i + 1 }, content: [{ type: 'text', text: `History ${i}\n\n` + 'A previously rendered response.\n\n'.repeat(3 + i % 5) }],
}))]))
const emit = (sessionID: string, type: string, data: object = {}) => (sseManager as any).handleEvent(instanceId, {
  id: `switch-${++time}`, type, created: time, location: { directory: '/fixture' }, data: { sessionID, ...data },
})
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async ({ sessionID }: any) => ({ id: sessionID, title: sessionID, location: { directory: '/fixture' }, time: { created: 1, updated: 1 } }),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
  },
  model: { default: async () => ({ data: model }) },
  message: { list: async ({ sessionID, cursor, limit = 200 }: any) => ({ data: messages.get(sessionID)!.slice().reverse().slice(Number(cursor ?? 0), Number(cursor ?? 0) + limit), cursor: {} }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: '/fixture', port: 0, pid: 0, proxyPath: '', status: 'ready', client })
setSessions(previous => new Map(previous).set(instanceId, new Map(['A', 'B'].map(id => [id, {
  id, instanceId, parentId: null, title: id, agent: 'build', model: { providerId: 'fixture', modelId: 'fixture' },
  status: 'idle', retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true, version: '1', projectID: 'fixture', location: { directory: '/fixture' },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
}]))))
setProviders(prev => new Map(prev).set(instanceId, [{ id: 'fixture', name: 'Fixture', models: [{ id: 'fixture', name: 'Fixture', providerId: 'fixture', limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } }] }]))
setActiveSession(instanceId, 'A')
const store = messageStoreBus.getOrCreate(instanceId)
render(() => <ConfigProvider><I18nProvider><ThemeProvider><For each={['A', 'B']}>{id => (
  <div data-session-id={id} style={{ display: active() === id ? 'flex' : 'none', flex: '1', 'min-height': '0' }}>
    <SessionView sessionId={id} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder='/fixture' escapeInDebounce={false} isActive={active() === id} />
  </div>
)}</For></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById('root')!)
;(window as any).fixture = {
  seedHistory: () => loadMessages(instanceId, 'A', { force: true }),
  switchTo: (id: string) => { setActiveSession(instanceId, id); setActive(id) },
  start: (id: string) => {
    emit(id, 'session.execution.started')
    emit(id, 'session.step.started', { assistantMessageID: `stream-${id}`, agent: 'build', model })
    emit(id, 'session.text.started', { assistantMessageID: `stream-${id}` })
  },
  delta: (id: string, delta: string) => emit(id, 'session.text.delta', { assistantMessageID: `stream-${id}`, ordinal: 0, delta }),
  snapshot: () => ({ window: store.getMessageWindow('A'), scroll: store.getScrollSnapshot('A', 'message-stream') }),
}
