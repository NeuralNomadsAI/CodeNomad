# Era Code Integration Scope

## Executive Summary

This document outlines the comprehensive scope for migrating CodeNomad from using vanilla `opencode` to Era's governance-enhanced `era-code` CLI, and integrating era-code's custom features into the UI.

Era-code (v3.0.0) is a wrapper around OpenCode that adds:
- **Governance enforcement** via bash command filtering
- **Directive management** for project-specific AI behavior guidelines
- **OAuth authentication** with Era's identity provider
- **Custom agents, commands, and skills** tailored to Era's development workflows
- **Constitution-based compliance auditing**

---

## Current State Analysis

### CodeNomad Architecture

```
packages/
├── server/           # Node.js server managing workspaces
│   └── src/
│       ├── workspaces/
│       │   ├── runtime.ts      # Spawns opencode binary
│       │   └── pid-registry.ts # Process lifecycle management
│       └── config/
│           └── binaries.ts     # Binary selection/registry
├── ui/               # SolidJS frontend
└── electron-app/     # Electron wrapper
```

**Current Binary Launch Flow:**
1. `BinaryRegistry` resolves default binary path (currently "opencode")
2. `WorkspaceRuntime.launch()` spawns: `{binaryPath} serve --port 0 --print-logs --log-level DEBUG`
3. Process is managed until exit/stop

### Era-Code Architecture

```
~/.era/
├── credentials.json           # OAuth tokens (access, refresh, id)
├── era-code/
│   ├── manifest.json          # Installed files manifest
│   ├── version                # Current version (3.0.0)
│   ├── bin/
│   │   └── era-start.sh       # Git sync + launch script
│   └── opencode/
│       ├── agent/             # Custom agents (7 agents)
│       ├── command/           # Slash commands (16 commands)
│       ├── plugin/            # Governance & directives plugins
│       └── skill/             # Specialized skills (10 skills)
```

**Era-Code Launch Flow:**
1. `era-code start` validates Era initialization
2. Loads governance config from hierarchy
3. Injects plugins, agents, commands, skills into OpenCode
4. Spawns OpenCode with Era-managed configuration

---

## Integration Requirements

### Phase 1: Binary Migration (Core)

#### 1.1 Default Binary Change

| Component | Current | Target |
|-----------|---------|--------|
| Default binary | `opencode` | `era-code` |
| Launch command | `opencode serve ...` | `era-code start` OR OpenCode with era config |

**Decision Required:** Two approaches:
- **Option A:** Call `era-code start` directly (wraps opencode)
- **Option B:** Call `opencode serve` with era-code's plugin/agent injection

**Recommendation:** Option B for finer control, using era-code's assets directly.

#### 1.2 Binary Registry Updates

```typescript
// packages/server/src/config/binaries.ts

// Add era-code detection
detectEraBinary(): string | null {
  // Check: which era-code
  // Verify: era-code --version
  // Return path if valid
}

// Update default resolution
resolveDefault(): BinaryRecord {
  // Priority: era-code > opencode > fallback
}
```

#### 1.3 Runtime Launch Updates

```typescript
// packages/server/src/workspaces/runtime.ts

interface LaunchOptions {
  workspaceId: string
  folder: string
  binaryPath: string
  environment?: Record<string, string>
  eraEnabled?: boolean           // NEW
  eraConfig?: EraLaunchConfig    // NEW
}

interface EraLaunchConfig {
  plugins: string[]     // Paths to era plugins
  agents: string[]      // Paths to era agents
  commands: string[]    // Paths to era commands
  skills: string[]      // Paths to era skills
  governanceConfig?: string  // Path to governance.yaml
}
```

---

### Phase 2: Era Governance Integration

#### 2.1 Governance Plugin Integration

Era-code's governance plugin (`era-governance.ts`) provides:
- **Hardcoded denials** (cannot override): sudo, rm -rf /, secrets extraction
- **Default denials** (can override): kubectl apply, helm install, docker push, etc.
- **Custom rules** via project/user config

**UI Requirements:**

1. **Governance Status Indicator**
   - Show governance state in status bar
   - Visual feedback when commands are blocked
   - Link to governance configuration

2. **Governance Configuration UI**
   - View current governance rules
   - Toggle default deny rules (with justification)
   - Add custom rules

3. **Blocked Command Feedback**
   - Display blocked command reason in chat
   - Show suggestion for alternative
   - Provide override path (if overridable)

#### 2.2 Governance Config Management

```typescript
// New: packages/server/src/era/governance.ts

interface GovernanceRule {
  id: string
  pattern: string
  action: 'allow' | 'deny'
  reason: string
  suggestion?: string
  overridable: boolean
  source: 'hardcoded' | 'default' | 'project' | 'user'
}

interface GovernanceConfig {
  auditMode: boolean
  rules: GovernanceRule[]
  customRules: CustomRule[]
}

// API endpoints
GET /api/governance/rules         // List all rules
GET /api/governance/config        // Get effective config
PUT /api/governance/rules/:id     // Override rule
POST /api/governance/custom       // Add custom rule
```

---

### Phase 3: Era Authentication Integration

#### 3.1 OAuth Flow

Era-code uses Ory Hydra OAuth2 at `oauth.era.computer`:
- Scopes: `openid`, `offline_access`, `profile`, `email`
- Tokens stored in `~/.era/credentials.json`
- JWT contains user info (email, name, sub)

**UI Requirements:**

1. **Login Status Display**
   - Show logged-in user in settings/header
   - Display token expiration warning
   - Logout option

2. **Login Flow**
   - Detect when era-code needs authentication
   - Trigger browser-based OAuth flow
   - Handle token refresh

3. **Token Management**
   ```typescript
   interface EraCredentials {
     accessToken: string
     refreshToken: string
     idToken: string
     expiresAt: number
     user: {
       email: string
       name: string
       sub: string
     }
   }
   ```

#### 3.2 Authentication API

```typescript
// New: packages/server/src/era/auth.ts

class EraAuthService {
  getCredentials(): EraCredentials | null
  isAuthenticated(): boolean
  needsRefresh(): boolean
  refreshTokens(): Promise<void>
  initiateLogin(): Promise<string>  // Returns auth URL
  handleCallback(code: string): Promise<void>
  logout(): Promise<void>
}

// API endpoints
GET /api/era/auth/status
POST /api/era/auth/login
POST /api/era/auth/refresh
POST /api/era/auth/logout
```

---

### Phase 4: Custom Agents Integration

#### 4.1 Era Agent Types

| Agent | Description | Mode |
|-------|-------------|------|
| orchestration | Main coding agent with mandatory delegation | primary |
| plan | Software architecture planning | |
| explore | Codebase exploration | |
| researcher | Documentation/library research | |
| docs-generator | Generate /docs folder | |
| readme-generator | Generate README.md | |
| debugger | Systematic debugging | |

**UI Requirements:**

1. **Agent Selector Enhancement**
   - Display era agents in dropdown
   - Show agent description on hover
   - Group by source (era vs custom)

2. **Agent Status in Session**
   - Show current agent in session header
   - Display agent mode (primary, etc.)

3. **Agent Switching**
   - Allow mid-session agent switch
   - Warn on incompatible switches

#### 4.2 Agent Configuration

```typescript
interface EraAgent {
  id: string
  name: string
  description: string
  mode: 'primary' | 'secondary'
  temperature: number
  permissions: AgentPermissions
  source: 'era' | 'project' | 'user'
}

// API endpoints
GET /api/era/agents              // List available agents
GET /api/era/agents/:id          // Get agent details
PUT /api/session/:id/agent       // Switch agent
```

---

### Phase 5: Custom Commands (Slash Commands) Integration

#### 5.1 Era Commands

| Command | Description | Agent |
|---------|-------------|-------|
| /era-directives | Create/update project directives | orchestrate |
| /era-sync-directives | Sync directives from main branch | orchestrate |
| /era-bootstrap-directives | Bootstrap directives for existing project | orchestrate |
| /era-constitution-fix | Fix constitution violations | orchestrate |
| /era-audit | Run constitution compliance audit | plan |
| /project-status | Check project status | - |
| /docs-internal | Generate internal docs | - |
| /docs-external | Generate external docs | - |
| /research | Research topics | - |
| /readme | Generate README | - |
| /plan | Plan implementation | - |
| /brainstorm | Brainstorming session | - |
| /explore | Explore codebase | - |
| /debug | Systematic debugging | - |

**UI Requirements:**

1. **Command Autocomplete Enhancement**
   - Include era commands in autocomplete
   - Show command description
   - Display required agent (if any)

2. **Command Execution Feedback**
   - Show when directives are rebuilt
   - Display audit results in structured format

3. **Command Configuration**
   - Allow enabling/disabling commands
   - Custom command aliases

#### 5.2 Commands API

```typescript
interface EraCommand {
  id: string
  name: string
  description: string
  agent?: string
  template: string
  source: 'era' | 'project' | 'user'
}

// API endpoints
GET /api/era/commands            // List available commands
POST /api/era/commands/:id/execute  // Execute command
```

---

### Phase 6: Skills Integration

#### 6.1 Era Skills

| Skill | Description |
|-------|-------------|
| directives-advisor | Advise on project directives |
| docs-generator | Generate /docs documentation |
| README-generator | Generate README files |
| brainstorming | Brainstorming sessions |
| checking-project-status | Check project status |
| researching-topics | Research methodology |
| searching-external-docs | Search external documentation |
| searching-internal-docs | Search internal docs |
| systematic-debugging | Debugging methodology |
| hosted-apps | Era application deployment |

**UI Requirements:**

1. **Skills Panel**
   - List available skills
   - Show skill descriptions
   - Display skill references

2. **Skill Invocation**
   - Skills invoked via commands/agents
   - Show skill activity in session

---

### Phase 7: Directives Management UI

#### 7.1 Directives System

Era's directive system:
```
.era/memory/
├── constitution.md           # Immutable, Era-managed
├── directives.md             # Compiled directives (auto-generated)
└── directives/               # Source directive files
    ├── _config.yaml          # Auto-generated from .md files
    ├── 000-upstream-header.md
    ├── development.md
    ├── testing.md
    ├── security.md
    └── 999-upstream-footer.md
```

**UI Requirements:**

1. **Directives Browser**
   - Tree view of directive categories
   - View directive content
   - Edit directive content (with validation)

2. **Constitution Viewer**
   - Read-only constitution display
   - Highlight compliance requirements

3. **Directive Editor**
   - Syntax highlighting for directive format
   - Validation against constitution
   - Preview compiled output

4. **Sync Status**
   - Show directive sync state
   - Trigger manual rebuild
   - Display last build time

#### 7.2 Directives API

```typescript
interface DirectiveCategory {
  id: string
  title: string
  order: number
  version: string
  lastUpdated: string
  directives: Directive[]
}

interface Directive {
  id: string
  title: string
  content: string
  categoryId: string
}

// API endpoints
GET /api/era/directives                    // List categories
GET /api/era/directives/:categoryId        // Get category
PUT /api/era/directives/:categoryId/:id    // Update directive
POST /api/era/directives/:categoryId       // Add directive
DELETE /api/era/directives/:categoryId/:id // Remove directive
POST /api/era/directives/rebuild           // Trigger rebuild
GET /api/era/constitution                  // Get constitution
```

---

### Phase 8: Era Project Initialization

#### 8.1 Project Status Detection

**UI Requirements:**

1. **Era Status Indicator**
   - Show if project has `.era/` directory
   - Display Era version if initialized
   - Show validation status

2. **Initialization Wizard**
   - Detect non-Era projects
   - Prompt to initialize Era
   - Walk through setup options

3. **Validation Dashboard**
   - Run `era-code validate`
   - Display issues with fix suggestions
   - Auto-fix option for supported issues

#### 8.2 Initialization API

```typescript
interface EraProjectStatus {
  initialized: boolean
  version?: string
  valid: boolean
  issues: ValidationIssue[]
}

interface ValidationIssue {
  severity: 'error' | 'warning'
  message: string
  path?: string
  autoFixable: boolean
}

// API endpoints
GET /api/era/status                        // Get project status
POST /api/era/init                         // Initialize Era
POST /api/era/validate                     // Validate project
POST /api/era/validate/fix                 // Auto-fix issues
```

---

## UI Component Changes

### New Components

| Component | Description | Priority |
|-----------|-------------|----------|
| `EraStatusBadge` | Governance/auth status indicator | High |
| `GovernancePanel` | View/configure governance rules | High |
| `DirectivesBrowser` | Browse/edit directives | Medium |
| `ConstitutionViewer` | Read-only constitution display | Medium |
| `EraLoginDialog` | OAuth login flow | High |
| `EraInitWizard` | Project initialization wizard | Medium |
| `AuditResultsPanel` | Display compliance audit results | Low |

### Modified Components

| Component | Changes | Priority |
|-----------|---------|----------|
| `SettingsPanel` | Add Era section (auth, governance, directives) | High |
| `CommandAutocomplete` | Include era commands with descriptions | High |
| `AgentSelector` | Show era agents with grouping | Medium |
| `StatusBar` | Add governance/era status | High |
| `MessageBlock` | Styled governance block messages | Medium |

---

## API Endpoints Summary

### Era Core

```
GET  /api/era/status           # Project era status
POST /api/era/init             # Initialize era
POST /api/era/validate         # Validate project
POST /api/era/validate/fix     # Auto-fix issues
```

### Era Auth

```
GET  /api/era/auth/status      # Auth status
POST /api/era/auth/login       # Initiate login
POST /api/era/auth/callback    # OAuth callback
POST /api/era/auth/refresh     # Refresh tokens
POST /api/era/auth/logout      # Logout
```

### Era Governance

```
GET  /api/era/governance/rules   # List rules
GET  /api/era/governance/config  # Effective config
PUT  /api/era/governance/rules/:id  # Override rule
POST /api/era/governance/custom  # Add custom rule
DELETE /api/era/governance/custom/:id  # Remove custom rule
```

### Era Directives

```
GET  /api/era/directives         # List categories
GET  /api/era/directives/:id     # Get category
PUT  /api/era/directives/:catId/:id  # Update directive
POST /api/era/directives/:catId  # Add directive
DELETE /api/era/directives/:catId/:id  # Remove directive
POST /api/era/directives/rebuild # Rebuild directives
GET  /api/era/constitution       # Get constitution
```

### Era Agents/Commands/Skills

```
GET  /api/era/agents             # List agents
GET  /api/era/commands           # List commands
GET  /api/era/skills             # List skills
```

---

## Implementation Phases

### Phase 1: Core Migration (Week 1-2)
- [ ] Detect era-code binary
- [ ] Update default binary resolution
- [ ] Launch with era-code assets injection
- [ ] Era status endpoint

### Phase 2: Governance (Week 2-3)
- [ ] Governance status in UI
- [ ] Governance rules API
- [ ] Blocked command feedback
- [ ] Rule override UI

### Phase 3: Authentication (Week 3-4)
- [ ] Era auth service
- [ ] Login flow integration
- [ ] User display in UI
- [ ] Token refresh handling

### Phase 4: Agents/Commands (Week 4-5)
- [ ] Era agents API
- [ ] Agent selector enhancement
- [ ] Era commands API
- [ ] Command autocomplete enhancement

### Phase 5: Directives (Week 5-6)
- [ ] Directives API
- [ ] Directives browser UI
- [ ] Directive editor
- [ ] Constitution viewer

### Phase 6: Project Management (Week 6-7)
- [ ] Era project status API
- [ ] Initialization wizard
- [ ] Validation dashboard
- [ ] Audit results panel

---

## Configuration Files

### Server Config Updates

```yaml
# packages/server/config.yaml (proposed additions)
era:
  enabled: true
  autoDetect: true
  assetsPath: ~/.era/era-code/opencode
  governance:
    auditMode: false
  auth:
    enabled: true
    clientId: era-cli
    issuer: https://oauth.era.computer
```

### UI Preferences Updates

```typescript
// packages/ui/src/stores/preferences.tsx

interface EraPreferences {
  enabled: boolean
  showGovernanceStatus: boolean
  showDirectivesPanel: boolean
  defaultAgent: string
}
```

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Era-code not installed | High | Fallback to opencode, prompt installation |
| Auth token expiry during session | Medium | Background refresh, re-auth flow |
| Governance blocks critical command | Medium | Clear feedback, override path |
| Directive conflicts with constitution | Medium | Validation before save |
| Binary version mismatch | Low | Version check on launch |

---

## Success Criteria

1. **Seamless Migration**: Existing users can continue using opencode if era-code not installed
2. **Governance Visibility**: Users understand why commands are blocked and how to override
3. **Auth Integration**: Users can authenticate and see their identity in UI
4. **Directive Management**: Users can view and edit directives without CLI
5. **Agent/Command Parity**: All era commands accessible from UI

---

## Appendix

### Era-Code Binary Detection

```bash
# Detection script
which era-code && era-code --version
# Expected: /opt/homebrew/bin/era-code, 3.0.0
```

### Era Assets Location

```bash
~/.era/era-code/opencode/
├── agent/      # 7 agent definitions
├── command/    # 16 command definitions
├── plugin/     # 2 plugins (governance, directives)
└── skill/      # 10 skill definitions
```

### OAuth Configuration

```
Issuer: https://oauth.era.computer
Client ID: era-cli
Scopes: openid, offline_access, profile, email
Token Endpoint: https://oauth.era.computer/oauth2/token
```
