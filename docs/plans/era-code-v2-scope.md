# Era Code v2+ Scope

Features deferred from v1 for future implementation.

---

## 1. Cross-Project Context

### 1.1 Problem Statement

In v1, each project (directory) is strictly isolated. Users cannot reference files from other projects within a session. This limits workflows where:
- Shared libraries exist across multiple projects
- Monorepo-adjacent setups with related but separate repos
- Learning from patterns in one project to apply in another

### 1.2 Proposed Solution: Linked Projects

Allow users to "link" projects that can share context.

**UI: Project Settings → Linked Projects**
```
┌─────────────────────────────────────────────────────────────────┐
│  LINKED PROJECTS                                                │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  These projects can be referenced in conversations:             │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 📁 shared-components    ~/projects/shared-components    │   │
│  │                                              [Unlink]   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 📁 design-system        ~/projects/design-system        │   │
│  │                                              [Unlink]   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│                                    [+ Link Another Project]    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Usage in Chat:**
```
User: Look at how we handle auth in @linked:shared-components/src/auth.ts
      and implement something similar here.
```

### 1.3 Technical Considerations

- Linked projects are read-only in the context of the current session
- File writes only allowed in the active project directory
- OpenCode process needs access to multiple directories
- Security: User must explicitly link projects (no automatic discovery)

### 1.4 Open Questions

- Max linked projects? (suggest: 5)
- Can linked projects have their own linked projects? (suggest: no, single level)
- How to handle conflicting file paths?

---

## 2. Linked Multi-Window Support

### 2.1 Problem Statement

In v1, multiple windows are independent. Opening the same project in two windows creates two separate OpenCode processes. This wastes resources and causes state divergence.

### 2.2 Proposed Solution: Window Sync

**Option A: Single Process, Multiple Views**
- One OpenCode process per project, regardless of windows
- Windows show the same sessions and messages
- Real-time sync via shared state

**Option B: Tab Dragging Between Windows**
- Drag a project tab from Window A to Window B
- Project "moves" to new window (process stays alive)
- Original window updates to show project is "in another window"

### 2.3 UI: Tab Dragging

```
Window 1:                          Window 2:
┌──────────────────────┐          ┌──────────────────────┐
│ [my-startup ×] [+]   │          │ [website ×] [+]      │
│                      │   drag   │                      │
│  Dragging...         │ ──────▶  │  [Drop here]         │
│  ┌─────────────┐     │          │                      │
│  │ my-startup  │     │          │                      │
│  └─────────────┘     │          │                      │
└──────────────────────┘          └──────────────────────┘
```

### 2.4 Technical Considerations

- Shared state management (consider using a local SQLite or shared memory)
- Process ownership when last window closes
- Conflict resolution if same session open in multiple windows

---

## 3. Session Templates

### 3.1 Problem Statement

Users often start sessions with similar prompts:
- "Review this PR"
- "Write tests for this file"
- "Explain this codebase"

### 3.2 Proposed Solution: Session Templates

**UI: New Session Dropdown**
```
[+ New ▾]
┌─────────────────────────────────┐
│ Blank Session                   │
│ ─────────────────────────────── │
│ TEMPLATES                       │
│   📝 Code Review                │
│   🧪 Write Tests                │
│   📖 Explain Code               │
│   🐛 Debug Issue                │
│   🔄 Refactor                   │
│ ─────────────────────────────── │
│ + Create Custom Template...     │
└─────────────────────────────────┘
```

**Template Definition:**
```json
{
  "name": "Code Review",
  "icon": "📝",
  "systemPrompt": "You are reviewing code for quality, security, and best practices.",
  "initialMessage": "Please review the following code and provide feedback:",
  "suggestedAgent": "code-review",
  "attachFileOnStart": true
}
```

### 3.3 Custom Templates

Users can create templates from:
- Existing sessions ("Save as Template")
- Settings page ("Create Template")
- Import/export JSON files

---

## 4. Session Branching & History

### 4.1 Problem Statement

AI conversations are linear. If a user wants to "go back" and try a different approach, they must start a new session and re-explain context.

### 4.2 Proposed Solution: Branching

**UI: Message Context Menu**
```
Right-click on any message:
┌─────────────────────────────┐
│ Copy Message                │
│ ─────────────────────────── │
│ 🌿 Branch from here         │
│ ─────────────────────────── │
│ Delete Message              │
└─────────────────────────────┘
```

**Branching creates:**
- New session tab with all messages up to that point
- Original session unchanged
- Branch indicator: "Branched from 'Fix auth' at message 5"

**Visual: Session Tab with Branches**
```
[Fix auth ×] [Fix auth (branch) ×] [+ New]
     │              ↑
     └──────────────┘
         branched
```

### 4.3 Session History View

**UI: Session History Panel**
```
┌─────────────────────────────────────────────────────────────────┐
│  SESSION HISTORY                                          [×]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Fix auth                                                       │
│  ├── Message 1: "Fix the authentication..."                     │
│  ├── Message 2: [AI response]                                   │
│  ├── Message 3: "Actually, try a different..."                  │
│  │   └── 🌿 Branch: "Fix auth (branch)"                         │
│  ├── Message 4: [AI response - original path]                   │
│  └── Message 5: "Perfect, that works"                           │
│                                                                 │
│  Fix auth (branch)                                              │
│  ├── (inherited messages 1-3)                                   │
│  ├── Message 4: [AI response - alternative path]                │
│  └── Message 5: "This approach is better"                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Collaborative Sessions (Multi-User)

### 5.1 Problem Statement

Teams working on the same codebase can't share AI sessions. Knowledge stays siloed.

### 5.2 Proposed Solution: Shared Sessions

**Prerequisites:**
- Era Code account system
- Team/organization support
- Real-time sync infrastructure

**Features:**
- Invite team members to view/contribute to a session
- Real-time cursors and typing indicators
- Permission levels: View / Comment / Edit
- Session ownership and transfer

### 5.3 UI: Share Session

```
┌─────────────────────────────────────────────────────────────────┐
│  Share Session                                            [×]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  "Fix authentication bug"                                       │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 🔗 https://era.code/s/abc123                      [Copy] │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  PEOPLE WITH ACCESS                                             │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 👤 You                                          Owner   │   │
│  │ 👤 teammate@company.com                    Can edit ▾   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Add people: email or username                           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Plugin System

### 6.1 Problem Statement

Different users have different workflows. A one-size-fits-all approach limits power users.

### 6.2 Proposed Solution: Era Code Plugins

**Plugin Types:**
- **UI Plugins** - Add panels, buttons, custom views
- **Agent Plugins** - Custom AI agents with specialized prompts
- **Tool Plugins** - Add new tool capabilities (linting, deployment, etc.)
- **Theme Plugins** - Custom color schemes and styling

**Plugin Marketplace:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Plugin Marketplace                                       [×]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  🔍 Search plugins...                                           │
│                                                                 │
│  FEATURED                                                       │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐      │
│  │ 🎨 Dracula     │ │ 🧪 Jest Runner │ │ 📊 Analytics   │      │
│  │ Theme          │ │ Run tests in   │ │ Usage stats    │      │
│  │                │ │ Era Code       │ │ for sessions   │      │
│  │ ★★★★★ 2.3k    │ │ ★★★★☆ 1.1k    │ │ ★★★★☆ 890     │      │
│  │ [Install]      │ │ [Install]      │ │ [Install]      │      │
│  └────────────────┘ └────────────────┘ └────────────────┘      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Voice Input & Output

### 7.1 Problem Statement

Typing long prompts is slow. Reading long responses takes time.

### 7.2 Proposed Solution: Voice Mode

**Features:**
- Push-to-talk voice input (transcribed via Whisper or similar)
- Text-to-speech for AI responses
- Voice commands: "Read that again", "Scroll up", "New session"

**UI: Voice Button**
```
┌────────────────────────────────────────────────────────────────────────────┐
│ │ Type your message...                                                  │  │
│ │                                                    [🎤] [Agent ▾] [⏎] │  │
│ └────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
                                                         ↑
                                                   Hold to speak
```

---

## 8. Mobile Companion App

### 8.1 Problem Statement

Developers sometimes need to check on long-running AI tasks or review code while away from their desk.

### 8.2 Proposed Solution: Era Code Mobile

**Features:**
- View session history (read-only initially)
- Push notifications for completed tasks
- Quick replies for simple follow-ups
- Sync with desktop app

**Not in Scope:**
- Full code editing on mobile
- Running OpenCode processes on mobile

---

## 9. AI Model Comparison Mode

### 9.1 Problem Statement

Users want to compare responses from different models (Claude vs GPT vs local).

### 9.2 Proposed Solution: Split View

**UI: Compare Mode**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [Compare Mode: ON]                                                          │
├───────────────────────────────────┬─────────────────────────────────────────┤
│                                   │                                         │
│  Claude claude-sonnet-4-20250514                   │  GPT-4o                              │
│  ─────────────────────────────    │  ─────────────────────────────────────  │
│                                   │                                         │
│  I'll fix the auth bug by...      │  To fix this authentication issue...    │
│                                   │                                         │
│  [Response continues...]          │  [Response continues...]                │
│                                   │                                         │
│                                   │                                         │
├───────────────────────────────────┴─────────────────────────────────────────┤
│ │ Type your message (sent to both models)...                            │  │
│ └────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Priority

| Feature | Complexity | User Value | Priority |
|---------|------------|------------|----------|
| Cross-Project Context | Medium | High | P1 |
| Linked Multi-Window | High | Medium | P2 |
| Session Templates | Low | High | P1 |
| Session Branching | Medium | High | P1 |
| Collaborative Sessions | Very High | High | P3 |
| Plugin System | Very High | Medium | P3 |
| Voice Input/Output | Medium | Medium | P2 |
| Mobile Companion | High | Medium | P3 |
| Model Comparison | Medium | Medium | P2 |

**Recommended v2 Focus:**
1. Session Templates (quick win)
2. Session Branching (high value)
3. Cross-Project Context (user requested)

---

*Last updated: 2026-01-03*
*Version: Draft 1.0*
