import { test, expect } from '@sand4rt/experimental-ct-solid'
import { SessionView } from './session-view'
import { TestProvider } from '../../lib/test-utils'
import { setSessions, setActiveSessionId } from '../../stores/session-state'
import { addInstance } from '../../stores/instances'

test.use({ viewport: { width: 1000, height: 800 } })

test('renders fallback when session is not found', async ({ mount }) => {
  const component = await mount(
    <TestProvider>
      <SessionView
        sessionId="non-existent"
        instanceId="test-instance"
        activeSessions={new Map()}
        instanceFolder="/test"
        escapeInDebounce={false}
      />
    </TestProvider>
  )

  await expect(component).toContainText('sessionView.fallback.sessionNotFound')
})

test('renders session content when session is found', async ({ mount }) => {
  const instanceId = 'test-instance'
  const sessionId = 'test-session'
  
  const mockSession: any = {
    id: sessionId,
    instanceId,
    title: 'Test Session',
    status: 'idle',
    time: { created: Date.now(), updated: Date.now() },
    agent: 'test-agent',
    model: { providerId: 'test-provider', modelId: 'test-model' }
  }

  // Prepopulate stores via their exported setters
  addInstance({ id: instanceId, folder: '/test', status: 'ready', client: null } as any)
  setSessions(new Map([[instanceId, new Map([[sessionId, mockSession]])]]))
  setActiveSessionId(new Map([[instanceId, sessionId]]))

  const component = await mount(
    <TestProvider>
      <div style="height: 100vh; display: flex; flex-direction: column;">
        <SessionView
          sessionId={sessionId}
          instanceId={instanceId}
          activeSessions={{ [sessionId]: mockSession } as any}
          instanceFolder="/test"
          escapeInDebounce={false}
          isActive={true}
        />
      </div>
    </TestProvider>
  )

  // Verify MessageSection is present (it has class .message-section usually)
  // or check for the PromptInput
  await expect(component.locator('.session-view')).toBeVisible({ timeout: 10000 })
  await expect(component.locator('.prompt-input')).toBeVisible({ timeout: 10000 })
  
  await component.screenshot({ path: 'session-view-ct.png' })
})
