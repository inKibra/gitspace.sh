# Stacked PR Feature - Architecture Design

> **⚠️ FUTURE FEATURE DOCUMENT**
>
> This document describes a **planned feature** that is **not yet implemented**.
> The `gssh stack` command does not currently exist. This is a design document for future development.

---

> AI-assisted splitting of work-in-progress commits into clean, logical PRs

## Overview

The `gssh stack` command helps developers split messy WIP commits into clean, reviewable PRs using AI-assisted code analysis in a sandboxed environment.

## Core Concept

```
User's messy branch:
main ── wip1 ── wip2 ── debug ── wip3 ── fixup ── wip4 ── more...
        └──────────── logical unit A ───────────┘  └── continued ──

After `gssh stack`:
main ── "Add auth" ── "Add tests" ──┬── (PR #1 created)
                                    │
                                    └── user's work rebased on top
```

**Key insight**: Instead of building a fixed algorithm, we give the AI tools (AST analysis, git operations) in a sandbox and let it explore different ways to split the code.

## Architecture

### High-Level Components

```
┌─────────────────────────────────────────────────────────────────────┐
│                        gssh stack command                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐ │
│  │   Diff      │    │  Sandbox    │    │   Interactive UI        │ │
│  │   Analyzer  │───▶│  + AI       │───▶│   (TUI/Prompts)        │ │
│  │             │    │  Explorer   │    │                         │ │
│  └─────────────┘    └─────────────┘    └─────────────────────────┘ │
│         │                  │                       │                │
│         ▼                  ▼                       ▼                │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐ │
│  │  AST        │    │  Virtual    │    │   Git Operations        │ │
│  │  Bindings   │    │  Filesystem │    │   (rebase, PR create)   │ │
│  └─────────────┘    └─────────────┘    └─────────────────────────┘ │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Dependencies

```json
{
  "dependencies": {
    "isomorphic-git": "^1.25.0",       // Git ops in sandbox
    "memfs": "^4.6.0",                  // Virtual filesystem
    "@babel/parser": "^7.23.0",         // AST parsing for JS/TS
    "@babel/traverse": "^7.23.0",       // AST traversal
    "@babel/types": "^7.23.0",          // AST type utilities
    "isolated-vm": "^4.7.0",            // V8 isolate sandbox
    "ai-flow": "...",                   // AI abstraction (OpenAI responses API compatible)
    "tensorzero": "..."                 // Multi-provider AI routing
  }
}
```

---

## Component Design

### 1. Diff Analyzer (`src/core/stack/diff-analyzer.ts`)

Parses git diff and extracts structured change information.

```typescript
interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  hunks: Hunk[];
  oldContent?: string;
  newContent?: string;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
  addedLines: Line[];
  removedLines: Line[];
}

// Functions
function parseDiff(diffText: string): FileChange[];
function getChangesInRange(repoPath: string, range: string): Promise<FileChange[]>;
function getFileAtRevision(repoPath: string, file: string, rev: string): Promise<string>;
```

### 2. AST Analysis Bindings (`src/core/stack/ast-bindings.ts`)

Provides TypeScript API for the AI sandbox to analyze code.

```typescript
interface Symbol {
  name: string;
  kind: 'function' | 'class' | 'type' | 'variable' | 'import' | 'export';
  file: string;
  line: number;
  exported: boolean;
}

interface Reference {
  symbol: string;
  file: string;
  line: number;
}

interface ASTBindings {
  // Parse code and return AST
  parse(code: string, language: string): AST;

  // Extract symbols defined in code
  findDefinitions(code: string, language: string): Symbol[];

  // Extract symbols referenced in code
  findReferences(code: string, language: string): Reference[];

  // Check if a set of changes is self-consistent
  checkDependencies(changes: FileChange[]): {
    valid: boolean;
    missing: Symbol[];      // Referenced but not defined
    circular: Symbol[][];   // Mutually dependent
  };

  // Get language from file extension
  detectLanguage(filename: string): string;
}
```

### 3. Dependency Graph (`src/core/stack/dependency-graph.ts`)

Builds and analyzes the dependency graph of changes.

```typescript
interface ChangeNode {
  id: string;
  files: string[];
  hunks: Hunk[];
  defines: Symbol[];
  references: Symbol[];
}

interface DependencyGraph {
  nodes: Map<string, ChangeNode>;
  edges: Map<string, Set<string>>;  // node -> depends on
}

// Functions
function buildGraph(changes: FileChange[], ast: ASTBindings): DependencyGraph;
function findStronglyConnectedComponents(graph: DependencyGraph): ChangeNode[][];
function topologicalSort(graph: DependencyGraph): ChangeNode[];
function suggestGroupings(graph: DependencyGraph): ProposedCommit[];
```

**Dependency Analysis Flow:**

```
Change A: Define `validateUser()` function
Change B: Use `validateUser()` in login.ts
Change C: Add `UserRole` type
Change D: Use `UserRole` in validateUser()

Dependency graph:
─────────────────────────────────
    C (UserRole)
        │
        ▼
    A (validateUser) ◄── D (uses UserRole in A)
        │
        ▼
    B (uses validateUser)
─────────────────────────────────

Valid orderings: C → A+D → B
Invalid: B before A (undefined function)
```

### 4. Virtual Filesystem + Sandbox (`src/core/stack/sandbox.ts`)

Creates an isolated environment where AI can experiment with different commit arrangements.

```typescript
interface SandboxFS {
  // Read file (from base + overlay)
  readFile(path: string): Promise<string>;

  // Write to overlay (doesn't affect real FS)
  writeFile(path: string, content: string): Promise<void>;

  // Apply a patch to the virtual FS
  applyPatch(patch: string): Promise<void>;

  // Reset overlay, keep base
  reset(): void;

  // Snapshot current state
  snapshot(): FSSnapshot;

  // Restore from snapshot
  restore(snapshot: FSSnapshot): void;
}

interface Sandbox {
  fs: SandboxFS;
  git: SandboxGit;      // isomorphic-git bound to virtual FS
  ast: ASTBindings;

  // Execute AI-generated code in isolated environment
  execute(code: string): Promise<any>;
}

// Implementation using memfs + isolated-vm
function createSandbox(repoPath: string, baseRef: string): Promise<Sandbox>;
```

**Sandbox Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                   Virtual FS Layer                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Base: Git tree at main (read-only)                            │
│      │                                                           │
│      ├── Overlay: Proposed changes (copy-on-write)              │
│      │                                                           │
│      └── AI can:                                                │
│           • Apply patch A, run tree-sitter, check deps          │
│           • Apply patch A+B, run tsc, see if it compiles        │
│           • Rollback, try different arrangement                 │
│           • Read any file as it would exist at that state       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5. AI Integration (`src/core/stack/ai-explorer.ts`)

Orchestrates AI exploration of different commit arrangements.

```typescript
interface ProposedCommit {
  message: string;
  files: string[];
  hunks: Hunk[];
  reasoning: string;
}

interface StackProposal {
  commits: ProposedCommit[];
  dependencyOrder: string[];  // Commit order
  warnings: string[];         // Things user should review
  conflicts: ConflictInfo[];  // Where user input needed
}

interface ConflictInfo {
  type: 'circular' | 'interleaved' | 'ambiguous';
  files: string[];
  description: string;
  options: string[];
}
```

**AI Sandbox Bindings:**

```typescript
import { AIFlow } from 'ai-flow';  // OpenAI responses API compatible

const AI_SYSTEM_PROMPT = `
You are analyzing code changes to split them into logical PRs.

You have access to these TypeScript APIs in your sandbox:
- git.getDiff(range): Get diff for commit range
- git.getFile(path, rev): Get file at revision
- ast.parse(code): Parse JS/TS to AST
- ast.findDefinitions(code): Find defined symbols
- ast.findReferences(code): Find referenced symbols
- ast.checkDeps(changes): Check if changes are self-consistent
- propose.group(files[], message): Propose a commit grouping
- propose.validate(groups[]): Validate proposed groupings

Write TypeScript code to explore the changes and propose logical groupings.
Return your final proposal via propose.finalize(groups[]).
`;
```

### 6. Interactive UI (`src/core/stack/ui.ts`)

TUI components for user interaction.

```
┌─────────────────────────────────────────────────────────────────┐
│  gssh stack - Analyzing changes...                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Found 47 changed lines across 8 files                          │
│  Base: main (3 commits behind)                                  │
│                                                                  │
│  Proposed Stack:                                                 │
│  ───────────────                                                │
│  PR #1: "Add user authentication middleware"                    │
│    ├── src/middleware/auth.ts (+45 -12)                        │
│    ├── src/types/user.ts (+8 -0)                               │
│    └── src/routes/login.ts (+15 -3)                            │
│                                                                  │
│  PR #2: "Update button styles"                                  │
│    └── src/styles/button.css (+5 -2)                           │
│                                                                  │
│  ⚠️  Needs Review:                                              │
│    src/utils/helpers.ts has changes for both PRs               │
│                                                                  │
│  [a] Accept  [e] Edit  [s] Split file  [?] Help                │
└─────────────────────────────────────────────────────────────────┘
```

**Features:**
- Show proposed groupings with file lists
- Highlight conflicts/warnings
- Allow editing commit messages
- Allow reassigning files/hunks to different commits
- Preview resulting git history
- Confirm before executing

### 7. Git Execution (`src/core/stack/git-executor.ts`)

Actually creates the branches and PRs.

```typescript
interface StackExecutionPlan {
  prBranches: string[];           // e.g., ["feature-auth", "feature-styles"]
  continuationBranch: string;     // Where remaining work goes
  commits: Map<string, ProposedCommit[]>;
  rebaseOnto: string;
}

async function executeStack(
  workspacePath: string,
  plan: StackExecutionPlan,
  createPRs: boolean
): Promise<{
  createdBranches: string[];
  prUrls?: string[];
  continuationBranch: string;
}>;
```

### 8. Stack State Tracking (`src/core/stack/stack-state.ts`)

Persists stack relationships for future `gssh stack sync`.

```typescript
// Stored in ~/gitspace/<project>/.stack-state.json
interface StackState {
  stacks: Stack[];
}

interface Stack {
  id: string;                     // UUID
  createdAt: string;
  baseBranch: string;             // e.g., "main"
  prs: StackedPR[];               // Ordered list (bottom to top)
  continuationBranch?: string;    // Branch with remaining work
}

interface StackedPR {
  branch: string;
  prNumber?: number;
  prUrl?: string;
  status: 'pending' | 'open' | 'merged' | 'closed';
  baseBranch: string;             // What this PR targets
  headCommit: string;             // For detecting updates
}
```

### 9. Stack Sync (`src/core/stack/sync.ts`) - Future

Handles rebasing when PRs are merged/updated.

```typescript
// gssh stack sync
async function syncStack(
  workspacePath: string,
  stackId: string
): Promise<{
  rebased: string[];              // Branches that were rebased
  conflicts: string[];            // Branches with conflicts
}>;

// Workflow:
// 1. Check status of each PR in stack (via gh api)
// 2. For merged PRs: rebase dependent branches onto new base
// 3. For updated PRs: detect force-push, rebase dependents
// 4. Report conflicts for manual resolution
```

---

## File Structure

```
src/
├── commands/
│   └── stack.ts                    # Command entry point
├── core/
│   └── stack/
│       ├── index.ts                # Main orchestrator
│       ├── diff-analyzer.ts        # Diff parsing
│       ├── ast-bindings.ts         # AST analysis API (Babel-based)
│       ├── dependency-graph.ts     # Graph analysis
│       ├── sandbox.ts              # Virtual FS + isolate
│       ├── ai-explorer.ts          # AI integration (ai-flow)
│       ├── git-executor.ts         # Git operations
│       ├── stack-state.ts          # Persist stack relationships
│       ├── sync.ts                 # Stack sync operations (future)
│       └── ui.ts                   # Interactive UI components
├── types/
│   └── stack.ts                    # Type definitions
```

**Integration Points:**
- `src/index.ts` - Register `stack` command with Commander.js
- `src/core/git.ts` - Reuse existing git utilities
- `src/utils/prompts.ts` - Reuse selectItem, promptInput, promptConfirm
- `src/core/config.ts` - Add getStackStateFile() path helper

---

## Command Interface

```bash
# Basic usage - analyze current branch vs main
gssh stack

# Specify base branch
gssh stack --base develop

# Specify commit range
gssh stack --range HEAD~5..HEAD

# Non-interactive mode (for CI/scripts)
gssh stack --auto

# Just analyze, don't execute
gssh stack --dry-run

# Provide hints to AI
gssh stack --hint "The auth changes should be separate from the UI changes"

# Stack sync - rebase dependent branches when PRs merge/update
gssh stack sync

# List active stacks
gssh stack list

# Show stack status (PR states, rebase needed)
gssh stack status
```

**Interactive Prompts:**
1. After analysis: "Create PRs now, or just prepare branches?" → [Create PRs] [Branches only]
2. Conflict resolution: "These files have interleaved changes" → [Split] [Keep together] [Show diff]
3. Commit messages: "Edit commit messages?" → [Accept] [Edit]

---

## Implementation Phases

### Phase 1: Foundation
**Files:** `package.json`, `src/types/stack.ts`, `src/core/stack/diff-analyzer.ts`

1. Add dependencies: `@babel/parser`, `@babel/traverse`, `memfs`, `isomorphic-git`, `isolated-vm`
2. Create type definitions
3. Implement diff analyzer
4. Add basic `gssh stack --dry-run` command

### Phase 2: AST Analysis
**Files:** `src/core/stack/ast-bindings.ts`, `src/core/stack/dependency-graph.ts`

1. Implement AST parsing with @babel/parser
2. Build dependency graph
3. Implement SCC detection and topological sort

### Phase 3: Sandbox Environment
**Files:** `src/core/stack/sandbox.ts`

1. Set up memfs virtual filesystem
2. Integrate isomorphic-git
3. Create isolated-vm sandbox with bindings

### Phase 4: AI Integration
**Files:** `src/core/stack/ai-explorer.ts`

1. Integrate ai-flow client
2. Create system prompt with binding docs
3. Implement exploration loop

### Phase 5: Interactive UI
**Files:** `src/core/stack/ui.ts`, `src/commands/stack.ts`

1. Analysis display
2. Conflict resolution UI
3. Commit message editing
4. File/hunk reassignment

### Phase 6: Git Execution
**Files:** `src/core/stack/git-executor.ts`, `src/core/stack/stack-state.ts`

1. Branch creation and commit application
2. PR creation via `gh` CLI
3. Continuation branch rebasing
4. State persistence

### Phase 7: Stack Management (Future)
**Files:** `src/core/stack/sync.ts`

1. `gssh stack list`
2. `gssh stack status`
3. `gssh stack sync`

### Phase 8: Polish
1. `--auto` mode
2. Progress indicators
3. Rollback on failure
4. Documentation

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| AST Parser | @babel/parser | Pure JS, no native deps, excellent JS/TS support |
| Sandbox | isolated-vm + memfs | True V8 isolate, fast startup, matches Cloudflare's approach |
| AI Provider | ai-flow + TensorZero | OpenAI responses API compatible, multi-provider support |
| PR Creation | User choice per run | Prompt each time for flexibility |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| AI produces invalid groupings | Validate with AST before presenting to user |
| Complex merges fail | Always work on copies, never modify user's branch until confirmed |
| Large diffs overwhelm AI | Chunk analysis, summarize first |
| Circular dependencies | Detect and flag for user resolution |
| isolated-vm compatibility | Fall back to worker threads if needed |

---

## Success Criteria

1. User can run `gssh stack` and see proposed commit groupings
2. Each proposed commit is syntactically valid (passes AST validation)
3. User can adjust groupings interactively
4. User chooses: create PRs automatically OR just prepare branches
5. Executing creates clean branches with logical commits
6. User's remaining work is correctly rebased on top of stack
7. Stack state is persisted for future `gssh stack sync`

---

## External Dependencies

1. **ai-flow** - AI abstraction library (OpenAI responses API compatible)
2. **TensorZero** - Multi-provider routing (optional)

---

## References

- [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/) - Inspiration for sandbox approach
- [Graphite](https://graphite.dev/) - Stacked PR workflow reference
