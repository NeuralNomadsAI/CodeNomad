# Agentic Platform Integration Plan

## Executive Summary

This document provides a comprehensive analysis of our agentic coding ecosystem and outlines an integration strategy for building a multi-user, server-hosted AI coding platform with GitHub integration, parallel workspaces, and intelligent conflict management.

**Our Ecosystem:**
- **Era Code CLI** (`@era-laboratories/era-code`) - Governance wrapper for OpenCode with agents, skills, commands
- **CodeNomad** (this repo) - Multi-instance UI/server with conflict detection and session management
- **OpenCode** - Model-agnostic AI coding agent (the underlying engine)

**External References (Claude Code specific, for inspiration only):**
- **Superpowers** (obra/superpowers) - 33.3k stars - Skills framework for Claude Code
- **Everything Claude Code** (affaan-m/everything-claude-code) - 16.4k stars - Production configurations

**Target Vision:**
A server-hosted platform where multiple users can log in, connect their GitHub repositories, and work on code in parallel using OpenCode agents governed by Era Code, with automatic conflict detection, merge capabilities, and structured development workflows.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CodeNomad (Multi-User Server)                        │
│                                                                              │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐    │
│  │   Web UI (SolidJS) │  │   REST API         │  │   SSE Events       │    │
│  │   - Session tabs   │  │   - /api/files/*   │  │   - file.conflict  │    │
│  │   - Conflict UI    │  │   - /api/sessions  │  │   - file.changed   │    │
│  │   - Worktree mgmt  │  │   - /api/worktrees │  │   - session.*      │    │
│  └────────────────────┘  └────────────────────┘  └────────────────────┘    │
│                                    │                                         │
│  ┌─────────────────────────────────┴─────────────────────────────────────┐  │
│  │                    Conflict Detection System (Implemented)             │  │
│  │   - FileWatchService (chokidar)                                        │  │
│  │   - FileChangeTracker (session → files mapping)                        │  │
│  │   - MergeService (3-way merge with diff-match-patch)                   │  │
│  │   - ConflictDetector (orchestrates detection + resolution)             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │ spawns
┌────────────────────────────────────┴────────────────────────────────────────┐
│                         Era Code CLI (Governance Layer)                      │
│                                                                              │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐       │
│  │  Constitution     │  │  Directives       │  │  Governance       │       │
│  │  (Immutable)      │  │  (Customizable)   │  │  Config           │       │
│  └───────────────────┘  └───────────────────┘  └───────────────────┘       │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Agents (7)                                                            │  │
│  │  orchestration | plan | debugger | explore | researcher |              │  │
│  │  readme-generator | docs-generator                                     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Skills (9)                                                            │  │
│  │  systematic-debugging | researching-topics | system-discovery |        │  │
│  │  checking-project-status | directives-advisor | docs-generator |       │  │
│  │  README-generator | brainstorming | hosted-apps                        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Commands (12)                                                         │  │
│  │  era-audit | era-bootstrap-directives | era-constitution-fix |         │  │
│  │  era-debug | era-directives | era-discover | era-explore |             │  │
│  │  era-plan | era-project-status | era-readme | era-research |           │  │
│  │  era-sync-directives                                                   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │ wraps
┌────────────────────────────────────┴────────────────────────────────────────┐
│                              OpenCode                                        │
│                     Model-Agnostic AI Coding Agent                           │
│                                                                              │
│  - Works with Claude, GPT-4, Gemini, local models                           │
│  - Built-in agents: build (full access), plan (read-only)                   │
│  - LSP support, file operations, bash execution                             │
│  - Extensible via .opencode/ directory                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Part 1: Current State Inventory

### 1.1 Era Code CLI (Already Implemented)

| Category | Items | Description |
|----------|-------|-------------|
| **Agents** | 7 | orchestration, plan, debugger, explore, researcher, readme-generator, docs-generator |
| **Skills** | 9 | systematic-debugging, researching-topics, system-discovery, checking-project-status, directives-advisor, docs-generator, README-generator, brainstorming, hosted-apps |
| **Commands** | 12 | era-audit, era-bootstrap-directives, era-constitution-fix, era-debug, era-directives, era-discover, era-explore, era-plan, era-project-status, era-readme, era-research, era-sync-directives |
| **Plugins** | 2 | era-directives, era-governance |
| **Governance** | 2-tier | Constitution (immutable) + Directives (customizable) |

### 1.2 CodeNomad (Already Implemented)

| Feature | Status | Description |
|---------|--------|-------------|
| **Multi-Instance UI** | ✓ | Manage multiple OpenCode sessions side-by-side |
| **Session Management** | ✓ | Create, switch, close sessions per instance |
| **File Conflict Detection** | ✓ | Real-time detection via chokidar file watcher |
| **3-Way Merge** | ✓ | Auto-merge non-overlapping changes, conflict markers for overlapping |
| **SSE Event System** | ✓ | file.changed, file.conflict, file.conflict.resolved events |
| **Content Hash Tracking** | ✓ | Track file versions per session |
| **Safe File Operations** | ✓ | Mutex-based locking, atomic writes |

### 1.3 What's Missing (To Be Built)

| Feature | Priority | Description |
|---------|----------|-------------|
| **Git Worktrees** | Critical | Isolated workspaces per task/branch |
| **Multi-User Auth** | Critical | GitHub OAuth, user sessions |
| **GitHub App Integration** | High | Clone repos, create PRs, sync branches |
| **Worktree Manager** | High | Create/cleanup worktrees, lifecycle management |
| **TDD Workflow Skill** | Medium | RED-GREEN-REFACTOR enforcement |
| **Code Review Skill** | Medium | Two-stage review (spec then quality) |
| **Verification Skill** | Medium | Pre-completion quality gate |

---

## Part 2: Comparison with External Projects

### 2.1 Era Code vs Superpowers (Claude Code)

| Aspect | Era Code | Superpowers | Notes |
|--------|----------|-------------|-------|
| **Target Platform** | OpenCode | Claude Code | Different underlying agents |
| **Skill Format** | SKILL.md with YAML frontmatter | Same format | Compatible! |
| **Systematic Debugging** | ✓ 4-phase process | ✓ 4-phase process | Era Code has this |
| **Planning** | ✓ plan agent + era-plan | ✓ write-plan skill | Era Code has this |
| **Research** | ✓ researcher agent | ✓ researching skill | Era Code has this |
| **Git Worktrees** | ✗ Not implemented | ✓ Full skill | **Import candidate** |
| **TDD Workflow** | ✗ Not implemented | ✓ Full skill | **Import candidate** |
| **Code Review** | ✗ Not implemented | ✓ Two-stage | **Import candidate** |
| **Verification** | ✗ Not implemented | ✓ Before completion | **Import candidate** |
| **Parallel Dispatch** | ✗ Not implemented | ✓ Domain isolation | **Import candidate** |

### 2.2 Era Code vs Everything Claude Code

| Aspect | Era Code | Everything Claude Code | Notes |
|--------|----------|------------------------|-------|
| **Target Platform** | OpenCode | Claude Code | Different underlying agents |
| **Agent Count** | 7 agents | 9 agents | Similar coverage |
| **Orchestration** | ✓ orchestration agent | ✓ /orchestrate command | Era Code has this |
| **Debugging** | ✓ debugger agent | ✗ Not specialized | Era Code better |
| **Security Review** | ✗ Not implemented | ✓ security-reviewer | **Inspiration** |
| **Memory Hooks** | ✗ Not implemented | ✓ Session persistence | **Inspiration** |
| **MCP Servers** | ✓ Configurable | ✓ 15 pre-configured | Era Code has this |

### 2.3 What to Import from Superpowers

Since Superpowers uses the same SKILL.md format, we can adapt skills for OpenCode:

| Skill | Priority | Adaptation Needed |
|-------|----------|-------------------|
| **git-worktrees** | Critical | Change tool references (Task → OpenCode equivalent) |
| **test-driven-development** | High | Adapt for OpenCode's test runners |
| **verification-before-completion** | High | Minimal adaptation |
| **code-review** | Medium | Adapt two-stage process |
| **dispatching-parallel-agents** | Medium | Map to Era Code's agent system |

---

## Part 3: Importability Strategy

### 3.1 Skill Adaptation Process

Since Era Code already uses SKILL.md format with YAML frontmatter, skills from Superpowers can be adapted:

```yaml
# Original Superpowers skill
---
name: git-worktrees
description: Use when working on multiple features...
---

# Adapted for Era Code (in era-code repo)
---
name: git-worktrees
description: Use when working on multiple features...
tools:
  - bash
  - read
  - write
---
```

### 3.2 Recommended Approach

**Option A: Fork and Adapt (Recommended)**
1. Create skills in `era-code/src/templates/resources/opencode/skill/`
2. Adapt Superpowers skills for OpenCode tool names
3. Maintain Era Code's governance integration

**Option B: Git Submodule (Not Recommended)**
- Superpowers is Claude Code-specific
- Would require runtime adaptation layer
- More complexity than value

### 3.3 Skills to Create in Era Code

| Skill | Source | Location |
|-------|--------|----------|
| `git-worktrees` | Adapt from Superpowers | `era-code/src/templates/.../skill/git-worktrees/SKILL.md` |
| `test-driven-development` | Adapt from Superpowers | `era-code/src/templates/.../skill/tdd/SKILL.md` |
| `verification-before-completion` | Adapt from Superpowers | `era-code/src/templates/.../skill/verification/SKILL.md` |
| `code-review` | Adapt from Superpowers | `era-code/src/templates/.../skill/code-review/SKILL.md` |

---

## Part 4: Multi-User Server Architecture

### 4.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Load Balancer                                   │
│                        (SSL termination, routing)                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            ▼                       ▼                       ▼
┌───────────────────┐   ┌───────────────────┐   ┌───────────────────┐
│  CodeNomad Server │   │  CodeNomad Server │   │  CodeNomad Server │
│   Instance 1      │   │   Instance 2      │   │   Instance N      │
│                   │   │                   │   │                   │
│ ┌───────────────┐ │   │ ┌───────────────┐ │   │ ┌───────────────┐ │
│ │ Auth Service  │ │   │ │ Auth Service  │ │   │ │ Auth Service  │ │
│ │ Worktree Mgr  │ │   │ │ Worktree Mgr  │ │   │ │ Worktree Mgr  │ │
│ │ Conflict Mgr  │ │   │ │ Conflict Mgr  │ │   │ │ Conflict Mgr  │ │
│ └───────────────┘ │   │ └───────────────┘ │   │ └───────────────┘ │
└───────────────────┘   └───────────────────┘   └───────────────────┘
            │                       │                       │
            └───────────────────────┼───────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────┐
        │                           │                       │
        ▼                           ▼                       ▼
┌───────────────┐         ┌───────────────┐         ┌───────────────┐
│    Redis      │         │  PostgreSQL   │         │  Object Store │
│  (Pub/Sub,    │         │   (Primary)   │         │   (S3/R2)     │
│   Sessions)   │         │               │         │               │
└───────────────┘         └───────────────┘         └───────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Workspace Cluster                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Workspace Controller                              │    │
│  │         (Orchestrates worktree creation/cleanup)                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│              │                    │                    │                     │
│              ▼                    ▼                    ▼                     │
│  ┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐         │
│  │   Worktree Pod    │ │   Worktree Pod    │ │   Worktree Pod    │         │
│  │   User A / Task 1 │ │   User A / Task 2 │ │   User B / Task 1 │         │
│  │                   │ │                   │ │                   │         │
│  │ ┌───────────────┐ │ │ ┌───────────────┐ │ │ ┌───────────────┐ │         │
│  │ │ Era Code CLI  │ │ │ │ Era Code CLI  │ │ │ │ Era Code CLI  │ │         │
│  │ │ + OpenCode    │ │ │ │ + OpenCode    │ │ │ │ + OpenCode    │ │         │
│  │ └───────────────┘ │ │ └───────────────┘ │ │ └───────────────┘ │         │
│  │ ┌───────────────┐ │ │ ┌───────────────┐ │ │ ┌───────────────┐ │         │
│  │ │ Git Worktree  │ │ │ │ Git Worktree  │ │ │ │ Git Worktree  │ │         │
│  │ │ /branch-feat  │ │ │ │ /branch-fix   │ │ │ │ /branch-docs  │ │         │
│  │ └───────────────┘ │ │ └───────────────┘ │ │ └───────────────┘ │         │
│  └───────────────────┘ └───────────────────┘ └───────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Bare Repository Storage                               │
│              (Shared .git objects across all worktrees)                      │
│                                                                              │
│   /repos/org-repo-1.git    /repos/org-repo-2.git    /repos/user-repo.git    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Database Schema (PostgreSQL)

```sql
-- Core user/auth tables
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    github_id BIGINT UNIQUE,
    github_login VARCHAR(255),
    avatar_url TEXT,
    plan VARCHAR(50) DEFAULT 'free',
    created_at TIMESTAMP DEFAULT NOW()
);

-- GitHub App installations (supports org + personal)
CREATE TABLE github_installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    installation_id BIGINT UNIQUE NOT NULL,
    account_type VARCHAR(20),  -- 'user' or 'organization'
    account_login VARCHAR(255),
    permissions JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Repositories with bare clone tracking
CREATE TABLE repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id UUID REFERENCES github_installations(id),
    github_repo_id BIGINT NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    default_branch VARCHAR(255) DEFAULT 'main',
    bare_clone_path VARCHAR(500),
    last_synced_at TIMESTAMP,
    UNIQUE(installation_id, github_repo_id)
);

-- Worktree sessions (one per task/branch)
CREATE TABLE worktrees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    repository_id UUID REFERENCES repositories(id),
    branch VARCHAR(255) NOT NULL,
    path VARCHAR(500) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    last_accessed_at TIMESTAMP DEFAULT NOW()
);

-- AI agent sessions within worktrees
CREATE TABLE agent_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worktree_id UUID REFERENCES worktrees(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    era_agent VARCHAR(50),  -- orchestration, plan, debugger, etc.
    status VARCHAR(20) DEFAULT 'running',
    tokens_used INT DEFAULT 0,
    started_at TIMESTAMP DEFAULT NOW(),
    ended_at TIMESTAMP
);

-- File changes tracked per agent session
CREATE TABLE file_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worktree_id UUID REFERENCES worktrees(id),
    agent_session_id UUID REFERENCES agent_sessions(id),
    file_path VARCHAR(500) NOT NULL,
    change_type VARCHAR(20),  -- created, modified, deleted
    content_hash VARCHAR(64),
    previous_hash VARCHAR(64),
    changed_at TIMESTAMP DEFAULT NOW()
);

-- Cross-worktree merge conflicts
CREATE TABLE merge_conflicts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_worktree_id UUID REFERENCES worktrees(id),
    target_branch VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    conflict_type VARCHAR(50),
    base_content TEXT,
    source_content TEXT,
    target_content TEXT,
    resolved_content TEXT,
    resolution_strategy VARCHAR(50),
    detected_at TIMESTAMP DEFAULT NOW(),
    resolved_at TIMESTAMP,
    resolved_by UUID REFERENCES users(id)
);

-- Pull requests created from worktrees
CREATE TABLE pull_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worktree_id UUID REFERENCES worktrees(id),
    repository_id UUID REFERENCES repositories(id),
    github_pr_number INT,
    github_pr_url VARCHAR(500),
    title VARCHAR(500),
    status VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW(),
    merged_at TIMESTAMP
);

-- Indexes
CREATE INDEX idx_worktrees_user ON worktrees(user_id, status);
CREATE INDEX idx_worktrees_repo ON worktrees(repository_id);
CREATE INDEX idx_file_changes_worktree ON file_changes(worktree_id, changed_at DESC);
CREATE INDEX idx_conflicts_pending ON merge_conflicts(source_worktree_id)
    WHERE resolved_at IS NULL;
```

### 4.3 Worktree + Conflict Integration

The existing CodeNomad conflict detection system integrates with worktrees:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         User Initiates Merge                             │
│                    (Worktree branch → target branch)                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Pre-Merge Conflict Detection                          │
│                  (git merge-tree --write-tree)                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
         ┌──────────────────┐            ┌──────────────────┐
         │   No Conflicts   │            │ Conflicts Found  │
         │                  │            │                  │
         │  Fast-forward    │            │  Use CodeNomad   │
         │  or merge        │            │  MergeService    │
         └──────────────────┘            └──────────────────┘
                                                  │
                    ┌─────────────────────────────┼─────────────────┐
                    │                             │                 │
                    ▼                             ▼                 ▼
         ┌──────────────────┐         ┌──────────────────┐  ┌─────────────┐
         │  Non-Overlapping │         │   Overlapping    │  │   Binary    │
         │    Changes       │         │    Text Edits    │  │   Files     │
         │                  │         │                  │  │             │
         │  Auto-merge via  │         │  3-Way Merge     │  │  User must  │
         │  MergeService    │         │  with markers    │  │  choose     │
         └──────────────────┘         └──────────────────┘  └─────────────┘
                    │                             │                 │
                    └─────────────────────────────┼─────────────────┘
                                                  │
                                                  ▼
                               ┌──────────────────────────────┐
                               │   Conflict Resolution UI     │
                               │   (Already in CodeNomad)     │
                               │                              │
                               │  - Side-by-side diff view    │
                               │  - Keep ours / Keep theirs   │
                               │  - Manual edit               │
                               └──────────────────────────────┘
                                                  │
                                                  ▼
                               ┌──────────────────────────────┐
                               │      Create Pull Request     │
                               │   (via GitHub API/Octokit)   │
                               └──────────────────────────────┘
```

---

## Part 5: Implementation Plan

### Phase 1: Era Code CLI Enhancement (Weeks 1-2)

**Goal:** Add missing skills to era-code repository

**Files to Create in `~/era-code`:**
```
src/templates/resources/opencode/skill/
├── git-worktrees/
│   ├── SKILL.md
│   └── references/
│       ├── worktree-commands.md
│       └── safety-checks.md
├── test-driven-development/
│   ├── SKILL.md
│   └── references/
│       ├── red-green-refactor.md
│       └── test-patterns.md
├── verification-before-completion/
│   ├── SKILL.md
│   └── references/
│       └── checklist.md
└── code-review/
    ├── SKILL.md
    └── references/
        ├── spec-review.md
        └── quality-review.md
```

**Implementation:**
1. Create git-worktrees skill (adapt from Superpowers)
2. Create test-driven-development skill (adapt from Superpowers)
3. Create verification-before-completion skill
4. Create code-review skill
5. Update era-code CLI to install new skills

### Phase 2: Worktree System in CodeNomad (Weeks 3-5)

**Goal:** Add worktree management to CodeNomad server

**Files to Create:**
```
packages/server/src/worktrees/
├── manager.ts           # Core worktree lifecycle
├── bare-repo.ts         # Bare clone management
├── cleanup.ts           # Idle worktree cleanup
└── index.ts

packages/server/src/server/routes/
├── worktrees.ts         # REST API endpoints
```

**Implementation:**
```typescript
// packages/server/src/worktrees/manager.ts
export class WorktreeManager {
  async create(userId: string, repoId: string, branch: string): Promise<Worktree>
  async merge(worktreeId: string, targetBranch: string): Promise<MergeResult>
  async cleanup(worktreeId: string): Promise<void>
  async cleanupIdle(maxIdleHours: number): Promise<number>
}
```

**API Endpoints:**
```
POST /api/worktrees              - Create new worktree
GET  /api/worktrees              - List user's worktrees
GET  /api/worktrees/:id          - Get worktree details
POST /api/worktrees/:id/merge    - Merge worktree to target
DELETE /api/worktrees/:id        - Archive/delete worktree
```

### Phase 3: GitHub App Integration (Weeks 6-7)

**Goal:** Enable GitHub repo access and PR creation

**Files to Create:**
```
packages/server/src/github/
├── app.ts               # GitHub App authentication
├── installation.ts      # Installation token management
├── api.ts               # Octokit wrapper
├── webhooks.ts          # Webhook handlers
└── index.ts
```

**Dependencies to Add:**
```json
{
  "@octokit/app": "^14.0.0",
  "@octokit/rest": "^20.0.0",
  "octokit-plugin-create-pull-request": "^5.0.0"
}
```

### Phase 4: Multi-User Authentication (Weeks 8-9)

**Goal:** User login via GitHub OAuth

**Files to Create:**
```
packages/server/src/auth/
├── github-oauth.ts      # GitHub OAuth flow
├── session.ts           # Session management
├── middleware.ts        # Auth middleware
├── tokens.ts            # JWT handling
└── index.ts
```

**Dependencies to Add:**
```json
{
  "jose": "^5.0.0",
  "ioredis": "^5.0.0"
}
```

### Phase 5: Database Integration (Weeks 10-11)

**Goal:** PostgreSQL for persistent state

**Files to Create:**
```
packages/server/src/db/
├── schema.ts            # Drizzle schema
├── migrations/          # SQL migrations
├── client.ts            # Database client
└── index.ts
```

**Dependencies to Add:**
```json
{
  "drizzle-orm": "^0.29.0",
  "pg": "^8.0.0",
  "drizzle-kit": "^0.20.0"
}
```

### Phase 6: UI Updates (Weeks 12-14)

**Goal:** Update CodeNomad UI for multi-user + worktrees

**Files to Create/Modify:**
```
packages/ui/src/
├── components/
│   ├── worktree-panel.tsx
│   ├── worktree-list.tsx
│   ├── merge-preview.tsx
│   └── github-connect.tsx
├── stores/
│   ├── worktrees.ts
│   ├── auth.ts
│   └── github.ts
└── styles/
    └── panels/worktrees.css
```

---

## Part 6: Timeline Summary

| Phase | Weeks | Key Deliverables |
|-------|-------|------------------|
| **1. Era Code Skills** | 1-2 | git-worktrees, TDD, verification, code-review skills |
| **2. Worktree System** | 3-5 | WorktreeManager, bare repos, API endpoints |
| **3. GitHub App** | 6-7 | OAuth, repo access, PR creation |
| **4. Multi-User Auth** | 8-9 | Login, sessions, JWT |
| **5. Database** | 10-11 | PostgreSQL schema, migrations |
| **6. UI Updates** | 12-14 | Worktree panel, GitHub connect |

---

## Part 7: Success Metrics

### Technical Metrics
- Worktree creation time < 5s
- Conflict detection accuracy > 95%
- Auto-merge success rate > 70%
- SSE latency < 50ms

### User Experience Metrics
- Time to first AI-assisted commit < 10 minutes
- Conflict resolution time < 2 minutes (auto) / < 5 minutes (manual)

### Business Metrics
- Concurrent users supported per server: 100+
- Worktrees per repository: 50+

---

## Appendix A: File Reference

### Era Code CLI (Skills to Add)
```
~/era-code/src/templates/resources/opencode/skill/
├── git-worktrees/SKILL.md           # NEW
├── test-driven-development/SKILL.md # NEW
├── verification-before-completion/SKILL.md # NEW
├── code-review/SKILL.md             # NEW
```

### CodeNomad (New Modules)
```
packages/server/src/
├── worktrees/                       # NEW
├── github/                          # NEW
├── auth/                            # NEW
├── db/                              # NEW
```

### Existing CodeNomad (Conflict System - Already Implemented)
```
packages/server/src/filesystem/
├── file-watch-service.ts            # ✓ Implemented
├── file-change-tracker.ts           # ✓ Implemented
├── merge-service.ts                 # ✓ Implemented
├── conflict-detector.ts             # ✓ Implemented
├── binary-detector.ts               # ✓ Implemented

packages/server/src/server/routes/
├── files.ts                         # ✓ Implemented
```

---

## Appendix B: Dependencies

### Already in CodeNomad
```json
{
  "chokidar": "^3.5.3",
  "diff-match-patch": "^1.0.5"
}
```

### To Add for Multi-User
```json
{
  "@octokit/app": "^14.0.0",
  "@octokit/rest": "^20.0.0",
  "jose": "^5.0.0",
  "ioredis": "^5.0.0",
  "drizzle-orm": "^0.29.0",
  "pg": "^8.0.0"
}
```
