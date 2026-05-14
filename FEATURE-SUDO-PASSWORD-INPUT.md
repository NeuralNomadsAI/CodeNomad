# Feature Request: Sudo Password Input

**Date:** Mayo 14, 2026  
**Priority:** Medium  
**Status:** Proposed

---

## 💡 Problem

**Current behavior:**
```bash
# When AI tries to run sudo command
sudo pacman -S xorg-server

# Result:
sudo: a terminal is required to read the password; 
either use the -S option to read from standard input 
or configure an askpass helper
sudo: a password is required
```

**Impact:**
- AI cannot execute sudo commands
- User must manually copy/paste commands
- Breaks workflow continuity
- Less seamless experience

---

## 🎯 Proposed Solution

**Add password input capability to CodeNomad terminal/bash tool:**

### Option A: Password Prompt Modal

When AI executes sudo command:
1. CodeNomad detects `sudo` in command
2. Shows secure password modal
3. User enters password
4. Password passed to sudo via `-S` flag
5. Command executes
6. Password cleared from memory

**UI Mock:**
```
┌─────────────────────────────────────┐
│  Sudo Password Required             │
│                                     │
│  Command:                           │
│  > sudo pacman -S xorg-server       │
│                                     │
│  Password: [••••••••••]             │
│                                     │
│  [ Cancel ]          [ Execute ]   │
└─────────────────────────────────────┘
```

### Option B: Terminal PTY with Interaction

Upgrade Bash tool to support interactive commands:
- Allocate pseudo-terminal (PTY)
- Capture password prompts
- Show input UI in CodeNomad
- User types password
- Command completes

### Option C: Sudo Session Cache

User authorizes sudo once per session:
1. First sudo command: prompt for password
2. Cache sudo session (default 15 min)
3. Subsequent sudo commands work without prompt
4. Follows system `sudo` timeout

---

## 🏗️ Implementation Details

### Option A: Password Modal (Recommended)

**Pros:**
- ✅ Simple to implement
- ✅ Familiar UX
- ✅ Secure (password not in logs)
- ✅ Works with current Bash tool

**Cons:**
- ⚠️ Interrupts AI flow
- ⚠️ Requires user interaction

**Implementation:**

```typescript
// packages/ui/src/components/sudo-password-modal.tsx
interface SudoPasswordModalProps {
  command: string
  onSubmit: (password: string) => void
  onCancel: () => void
}

export function SudoPasswordModal(props: SudoPasswordModalProps) {
  const [password, setPassword] = createSignal('')
  
  return (
    <Modal open={true} onClose={props.onCancel}>
      <div class="sudo-password-modal">
        <h2>Sudo Password Required</h2>
        <div class="command-display">
          <code>{props.command}</code>
        </div>
        <input
          type="password"
          placeholder="Enter sudo password"
          value={password()}
          onInput={(e) => setPassword(e.target.value)}
          autofocus
        />
        <div class="actions">
          <button onClick={props.onCancel}>Cancel</button>
          <button onClick={() => props.onSubmit(password())}>Execute</button>
        </div>
      </div>
    </Modal>
  )
}
```

```typescript
// packages/server/src/tools/bash.ts
async function executeBashCommand(command: string) {
  // Detect sudo in command
  if (command.trim().startsWith('sudo ')) {
    // Request password from UI
    const password = await requestSudoPassword(command)
    
    if (!password) {
      return { error: 'Sudo password required but not provided' }
    }
    
    // Execute with password via stdin
    const child = spawn('sudo', ['-S', ...command.split(' ').slice(1)], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    
    // Send password to stdin
    child.stdin.write(password + '\n')
    child.stdin.end()
    
    // Collect output
    const stdout = await streamToString(child.stdout)
    const stderr = await streamToString(child.stderr)
    
    return { stdout, stderr, exitCode: await waitForExit(child) }
  }
  
  // Normal command execution
  return executeNormalCommand(command)
}
```

---

## 🔒 Security Considerations

### Password Handling

**Must:**
- ✅ Never log password
- ✅ Clear from memory immediately after use
- ✅ Use secure input (type="password")
- ✅ No persistence (never save)
- ✅ Encrypt in transit (already HTTPS)

**Must NOT:**
- ❌ Store password anywhere
- ❌ Show in command history
- ❌ Include in logs
- ❌ Send to OpenCode/AI
- ❌ Echo in terminal output

### Implementation Security

```typescript
function handleSudoPassword(password: string) {
  try {
    // Use password
    const result = await executeSudoCommand(password)
    return result
  } finally {
    // Clear from memory
    password = null
    // Force garbage collection if possible
    if (global.gc) global.gc()
  }
}
```

---

## 🎨 User Experience Flow

### Current (Manual)

```
1. AI: "I need to run: sudo pacman -S xorg-server"
2. AI: "But I can't, please run it manually"
3. User: Copies command
4. User: Opens terminal
5. User: Pastes command
6. User: Enters password
7. User: Tells AI "Done"
8. AI: Continues
```

**Total:** ~7 steps, context switch

### Proposed (With Feature)

```
1. AI: Runs sudo command
2. CodeNomad: Shows password modal
3. User: Enters password (5 seconds)
4. Command executes
5. AI: Continues with result
```

**Total:** ~3 steps, no context switch

---

## 📊 Similar Features in Other Tools

### VS Code Remote SSH
- Prompts for password in UI
- Caches for session
- Secure input

### JetBrains IDEs
- Terminal supports interactive commands
- Password prompts work
- PTY allocation

### GitHub Desktop
- Sudo prompts for git operations
- OS-level auth dialogs
- Credential caching

**Precedent:** This is a solved problem, well-established pattern

---

## 🚀 Rollout Plan

### Phase 1: Basic Implementation (Recommended Start)
- Detect `sudo` commands
- Show password modal
- Execute with `-S` flag
- No caching

**Effort:** ~8 hours
**Value:** High

### Phase 2: Session Caching
- Cache sudo authorization
- Follow system timeout (15 min)
- Option to disable cache

**Effort:** ~4 hours
**Value:** Medium

### Phase 3: PTY Support (Future)
- Full interactive terminal
- Any command that needs input
- More complex

**Effort:** ~40 hours
**Value:** High (enables more use cases)

---

## 🎯 Alternatives Considered

### 1. Passwordless Sudo (User Config)

User configures system:
```bash
# In /etc/sudoers
username ALL=(ALL) NOPASSWD: ALL
```

**Pros:**
- No code changes needed
- Works immediately

**Cons:**
- Security risk
- Not recommended practice
- User must configure

**Verdict:** Not recommended as primary solution

### 2. Polkit/pkexec

Use polkit instead of sudo:
```bash
pkexec pacman -S xorg-server
```

**Pros:**
- GUI password prompt (system-level)
- Better security model

**Cons:**
- Requires polkit policies
- Not all commands supported
- More complex setup

**Verdict:** Good for specific commands, not general solution

### 3. AI Asks User to Execute

Current behavior (do nothing):

**Pros:**
- Simple
- No security concerns

**Cons:**
- Poor UX
- Breaks flow
- Manual work

**Verdict:** Acceptable but suboptimal

---

## 💬 User Feedback

**Quote from user (you):**
> "codenomad deberia dejar introducir la password agregalo a features"

**Translation:**
> "CodeNomad should allow entering the password, add it to features"

**Interpretation:**
- Feature is desired
- Current limitation noticed
- Expectation for seamless sudo

---

## 📋 Acceptance Criteria

**Feature complete when:**
- [ ] AI can execute sudo commands
- [ ] User prompted for password (not stored)
- [ ] Password input is secure (type="password")
- [ ] Password never logged
- [ ] Works for any sudo command
- [ ] Error handling for wrong password
- [ ] Cancel option available
- [ ] Documentation updated

**Nice to have:**
- [ ] Session caching (15 min)
- [ ] Remember preference per workspace
- [ ] Keyboard shortcuts (Enter to submit)

---

## 🔗 Related

**Similar issues:**
- Interactive command support
- Terminal PTY allocation
- Input/output streaming

**Blockers:**
- None (can implement now)

**Dependencies:**
- UI framework (SolidJS) - already present
- IPC for server ↔ UI - already present

---

## 📝 Implementation Checklist

### Backend (Server)

- [ ] Detect sudo in command
- [ ] Request password from UI (IPC)
- [ ] Execute with `-S` flag
- [ ] Handle stdin/stdout/stderr
- [ ] Clear password from memory
- [ ] Error handling

### Frontend (UI)

- [ ] Create password modal component
- [ ] Secure input field
- [ ] Command display
- [ ] Cancel/Execute buttons
- [ ] Password validation
- [ ] Error display

### Security

- [ ] Never log password
- [ ] Clear from memory ASAP
- [ ] No persistence
- [ ] Secure IPC transport
- [ ] Audit password handling

### Testing

- [ ] Test with valid password
- [ ] Test with invalid password
- [ ] Test cancel
- [ ] Test multiple sudo commands
- [ ] Test password clearing

### Documentation

- [ ] User guide
- [ ] Security notes
- [ ] Developer docs

---

## 🎯 Priority & Effort

**Priority:** Medium
- Not critical but valuable
- Improves UX significantly
- Common use case

**Effort:** Medium (~12 hours total)
- Phase 1: 8 hours (basic)
- Phase 2: 4 hours (caching)

**ROI:** High
- Better UX
- Seamless workflow
- Competitive feature

---

## 🚀 Next Steps

1. **Discuss with maintainers**
   - Present this proposal
   - Get feedback
   - Agree on approach

2. **Create issue upstream**
   - Reference this document
   - Tag as "feature request"
   - Tag as "enhancement"

3. **Implement (if approved)**
   - Start with Phase 1
   - Get PR reviewed
   - Iterate

4. **Document**
   - User-facing docs
   - Security notes
   - Examples

---

## 📊 Example Use Cases

### Package Installation
```bash
sudo pacman -S xorg-server plasma-workspace-x11
# → Password prompt → Installs ✅
```

### System Configuration
```bash
sudo systemctl restart NetworkManager
# → Password prompt → Restarts ✅
```

### File Operations
```bash
sudo cp /etc/config.bak /etc/config
# → Password prompt → Copies ✅
```

### Service Management
```bash
sudo pm2 startup
# → Password prompt → Configures ✅
```

---

**Status:** Ready for upstream discussion and implementation

**Estimated Impact:** High user satisfaction, better workflow integration

**Risk:** Low (well-established pattern, clear security model)
