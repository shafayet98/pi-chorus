# Pi-Chorus Architecture

A self-organizing multi-agent coding system built on Pi, with tracing thorough enough to actually debug it.

You give it a task, not a headcount. An orchestrator decomposes the work and spawns agents from a role catalog you author. The team shape is an output of the run, not an input.

---

## Design Decisions

### Role catalog format — YAML files in `roles/`

YAML is human-readable, diffable, and maps cleanly to Pi's existing skill/prompt-template patterns. Each file is one role. Version-controlled like any config.

### Orchestrator identity — hardcoded system-level component

The orchestrator is not a catalog role. It has too many privileged responsibilities (spawning, arbitration, merge coordination, gate enforcement). It uses an LLM for task decomposition, but it's not a peer — it's the runtime.

### Claim granularity — non-overlapping files within shared path scope

Two instances of the same role can claim non-overlapping files within their shared path scope. `frontend#1` claims `src/components/Button.tsx`, `frontend#2` claims `src/components/Modal.tsx`. The scope defines what they *can* claim; the lease system ensures they don't overlap at runtime.

### Decision records — structured and machine-consumable

Schema with: `id`, `room_id`, `question`, `decision`, `rationale`, `participants[]`, `dissents[]`, `timestamp`, `causes[]`. Late-spawned agents get these injected, not raw transcripts.

### Verification gate — a pipeline, not a single command

An ordered list of commands (typecheck, test, lint, build). Individual agents also have local gates (e.g., "does my component compile?") before signaling DONE, to catch issues early and avoid wasting integration cycles.

---

## System Architecture

```
┌─────────────────────────────────────────────────────┐
│                    MISSION CLI                       │  ← you interact here
├─────────────────────────────────────────────────────┤
│                   ORCHESTRATOR                       │  ← decomposes task, spawns agents
├──────────┬──────────┬──────────┬────────────────────┤
│ Agent #1 │ Agent #2 │ Agent #3 │  ... (spawned)     │  ← from role catalog
├──────────┴──────────┴──────────┴────────────────────┤
│              COORDINATION LAYER                      │  ← send, rooms, decisions, claims
├─────────────────────────────────────────────────────┤
│              WORKTREE MANAGER                        │  ← git worktrees, merge, gates
├─────────────────────────────────────────────────────┤
│              TRACE STORE                             │  ← SQLite + content-addressed blobs
├─────────────────────────────────────────────────────┤
│         PI FOUNDATIONS (forked)                       │
│   agent-core · pi-ai · pi-telemetry · pi-tui        │
└─────────────────────────────────────────────────────┘
```

---

## Layer Details

### 1. Pi Foundations (forked)

**What we keep from Pi:**
- `pi-agent-core` — agent loop, state management, tool execution
- `pi-ai` — unified interface over 30+ LLM providers
- `pi-telemetry` — typed, vendor-neutral telemetry spans
- `pi-tui` — terminal UI with differential rendering

**What we strip:**
- `pi-coding-agent` CLI (replaced by our mission CLI)
- `pi-client` / `pi-server` / `pi-protocol` (no remote sessions needed for v1)

### 2. Trace Store (`packages/trace/`)

- SQLite database for events
- Content-addressed blob store (hash payloads, store once, reference by hash)
- Lamport clock implementation — ordering by causality, not wall time
- Three-phase message events: `send`, `deliver`, `consume` (the deliver→consume gap reveals inbox lag)
- `causes[]` on every event turns the log into a DAG for causal debugging

**Event schema:**
```
{
  id: string
  clock: number          // Lamport clock
  agent_id: string
  kind: string           // event kind
  causes: string[]       // IDs of events this was caused by
  payload_hash: string   // content-addressed reference
  timestamp: number      // wall time (secondary, for display only)
}
```

**Event kinds:**
- `lifecycle` — agent start, stop, crash
- `llm.request` / `llm.response` — with token counts
- `tool.*` — tool execution start/end
- `message.send` / `message.deliver` / `message.consume` — three-phase messaging
- `wait.begin` / `wait.end` — agent blocking
- `lease.grant` / `lease.deny` / `lease.release` — file claims
- `agent.spawn` — with requester, role, role version, rationale
- `room.open` / `room.join` / `room.resolve` — ephemeral rooms
- `decision.record` — room output
- `capability.request` / `capability.deny` / `capability.unmatched` — catalog lookups
- `file.write` / `file.delete` — file mutations
- `git.commit` / `git.merge` / `git.conflict` — git operations
- `gate.run` / `gate.pass` / `gate.fail` — verification

### 3. Worktree Manager (`packages/worktree/`)

- Creates/destroys one git worktree per agent — a private checkout each agent edits freely
- Manages the integration branch where completed work merges
- Merge logic: agent signals DONE → merge worktree into integration branch → run verification gate
- Conflict detection → emits `BLOCKED_ON` routed back to conflicting agents (never silently auto-resolved)
- Shared scratch space — a directory agents can read from pre-merge (generated schemas, interface stubs)

### 4. Coordination Layer (`packages/coordination/`)

**Message bus:**
Typed messages between agents. `send(target, message)` reaches the target and nobody else.

**Room manager:**
`open_room(topic, question, invite[])` — ephemeral rooms for negotiation. Bounded membership, stated question, exit condition. Three agents, one decision, then it dissolves. Turn budget per room, one designated asker. On budget exhaustion, the orchestrator arbitrates and writes the decision itself.

**Decision records:**
Structured outputs of rooms. Durable, injectable into agents who were never present. That's how a room's output outlives the room.

**Capability registry:**
Tracks which roles are currently instantiated and what they own. Agents check it before requesting a spawn; the orchestrator checks it before granting one.

**Lease manager:**
`claim(agent, paths[])` / `release(agent, paths[])`. Validates against the role's path scope. Rejects overlapping claims. Enforced at write time — a write to an unclaimed path is refused.

**Message types (typed and schema-enforced):**
- `CLAIM` — request file leases
- `REQUEST_INTERFACE` — ask for an interface definition
- `PROPOSE` — propose a decision in a room
- `ACCEPT` — accept a proposal
- `BLOCKED_ON` — signal a dependency
- `DONE` — signal work complete

### 5. Orchestrator (`packages/orchestrator/`)

**Responsibilities:**
- Receives a mission (task description + verification gate commands)
- Uses an LLM to decompose the task into subtasks
- Reads role catalog, matches subtasks to roles, spawns initial agents
- Handles `request_capability` — catalog lookup → spawn, or fall back to generic worker + emit `capability.unmatched`
- Manages mission lifecycle: tracks agent states, routes gate failures, enforces caps
- Arbitrates rooms that hit their turn budget
- Merges completed worktrees, runs verification gate pipeline
- Deadlock detection: cycle detection on wait-for graph, timeouts, watchdog kills youngest

**Caps enforced:**
- Max agents (total)
- Max spawn depth (agent spawning agent spawning agent...)
- Wall time budget
- Token budget (global)
- Repair round limit (how many times to retry after gate failure)

**Termination conditions:**
- Success: all agents DONE + gate passes
- Failure: gate fails after max repair rounds, or global caps exceeded
- Agent failure: leases released → respawn with failure context or reassign work

### 6. Role Catalog (`roles/`)

Static, version-controlled YAML files. Each entry defines one role.

```yaml
# roles/frontend.yaml
name: frontend
description: "React/TypeScript frontend development"
capabilities: [frontend, react, css, components]
system_prompt: |
  You are a frontend developer working on a React TypeScript project.
  You write clean, accessible components with proper typing.
model: sonnet
tools: [read, write, edit, bash, glob, grep]
path_scope:
  - src/components/**
  - src/pages/**
  - src/styles/**
  - src/hooks/**
local_gate: "npx tsc --noEmit"
```

```yaml
# roles/backend.yaml
name: backend
description: "Node.js/Express API development"
capabilities: [backend, api, rest, database]
system_prompt: |
  You are a backend developer building REST APIs with Node.js.
  You write well-structured, tested endpoints.
model: sonnet
tools: [read, write, edit, bash, glob, grep]
path_scope:
  - src/api/**
  - src/middleware/**
  - src/models/**
  - src/services/**
local_gate: "npm run test:api"
```

```yaml
# roles/db-migrations.yaml
name: db-migrations
description: "Database schema design and migrations"
capabilities: [database, migrations, schema]
system_prompt: |
  You are a database engineer responsible for schema design
  and migration safety.
model: sonnet
tools: [read, write, edit, bash]
path_scope:
  - migrations/**
  - prisma/**
  - src/models/**
local_gate: "npx prisma validate"
```

**Runtime behavior:**
- Roles are templates. Instances are spawned at runtime: `frontend#1`, `frontend#2` if work parallelizes.
- What's emergent is *which* roles get instantiated, how many, when, and who talks to whom — never the role definitions.
- `request_capability("api-schema")` is a catalog lookup, not a request to invent a new kind of agent.
- No match: orchestrator picks the nearest capability or falls back to a generic worker with a generated mandate, and emits `capability.unmatched` so you know the catalog has a gap.
- The trace records which role version spawned each instance, so a run is reproducible against a known catalog.

### 7. Agent Instance Runtime

Each spawned agent is a `pi-agent-core` agent with:
- Its own git worktree (private checkout)
- Tools scoped by its role definition (standard tools + coordination tools)
- Write operations intercepted by the lease manager (unclaimed path → rejected)
- Its own Lamport clock
- Briefing context: its mandate (subtask), relevant decision records, capability registry snapshot
- NOT the full mission history (that's how a $2 run stays $2)

**Coordination tools given to every agent:**

| Tool | Description |
|---|---|
| `send(to, message_type, payload)` | DM another agent |
| `open_room(topic, question, invite)` | Start a negotiation room |
| `claim(paths[])` | Request file leases |
| `release(paths[])` | Release file leases |
| `request_capability(tag)` | Ask orchestrator for a specialist |
| `signal_done()` | Mark work complete |
| `read_decision(decision_id)` | Get a room's decision record |
| `read_scratch(path)` | Read from shared scratch space |
| `write_scratch(path, content)` | Write to shared scratch space |

### 8. Mission CLI (`packages/cli/`)

```bash
# Run a mission
pi-chorus run "Build a todo app with auth" --gate "npm test && npm run build"

# Replay a trace (deterministic, keyed on llm.request hashes)
pi-chorus replay <mission-id>

# Open the trace viewer
pi-chorus view <mission-id>

# List past missions
pi-chorus list
```

### 9. Trace Viewer (local web app)

Reads from SQLite, runs locally. Live during a run, replayable after. No external services.

**Views:**
- **Swimlanes** — per-agent timeline of events
- **Causal DAG** — events linked by `causes[]`, walk backward from any broken commit
- **Critical path** — longest chain of causal dependencies
- **Roster timeline** — agents appearing over time, each linked to the message that caused its spawn (the most interesting artifact the system produces)
- **Decision provenance** — a decision → its room → its participants → every commit downstream
- **Lease contention** — which agents competed for which files
- **Context composition** — what each agent's context window contained at each turn

---

## Failure Modes and Defenses

### Spawn explosion
Agents request capabilities generously and every spawn is a context window.
**Defense:** Max agents cap, max spawn depth, registry-check-before-spawn (don't spawn if an existing agent has the capability).

### Rooms that never resolve
Three models can agree pleasantly forever.
**Defense:** Turn budget per room, one designated asker. On exhaustion, the orchestrator arbitrates and writes the decision itself.

### Cold-start briefing bloat
A new agent gets the full mission history and the $2 run becomes $40.
**Defense:** Late agents get: their mandate, relevant decision records, capability registry snapshot, and shared scratch contents. Not the full history.

### Deadlock
Mutual waits are the default failure mode, not an edge case.
**Defense:** Cycle detection on the wait-for graph, timeouts everywhere, watchdog kills the youngest agent in the cycle.

### Sandbox
Pi ships no permission system and runs with the privileges of whatever launched it. Autonomous peers running bash is a different risk class than one supervised agent.
**Defense:** Document Docker and micro-VM containerization. Sandbox from the start for autonomous runs.

---

## Build Plan

### Phase 1: Foundation

**Goal:** Fork Pi, set up monorepo, prove the fork works.

1. Clone the Pi repo into pi-chorus.
2. Strip packages we don't need: `pi-client`, `pi-server`, `pi-protocol`, `pi-coding-agent`.
3. Keep and verify: `pi-agent-core`, `pi-ai`, `pi-telemetry`, `pi-tui`.
4. Add new package scaffolds: `trace`, `worktree`, `coordination`, `orchestrator`, `cli`.
5. Get a single agent running from `pi-agent-core` with basic tools — prove the fork compiles and works.

### Phase 2: One Agent, One Worktree

**Goal:** A single agent that works in an isolated git worktree and merges back.

6. Build the worktree manager — create a worktree, let an agent work in it, merge it back to the integration branch, run a gate command.
7. Build the trace store — SQLite + content-addressed blob store. Emit basic events (agent lifecycle, tool calls). Implement Lamport clock.
8. Build the role catalog loader — read YAML files from `roles/`, parse them into agent configs.

### Phase 3: Two Agents, Talking

**Goal:** Two agents working in parallel, communicating, respecting file boundaries.

9. Build the coordination layer — message bus with typed messages. Start with `send()` (DMs).
10. Build the lease manager — `claim`/`release` on file paths, validated against role path scope, enforced at write time.
11. Build agent coordination tools — the Pi tools agents use to coordinate (`send`, `claim`, `release`, `signal_done`).
12. **Integration test:** Two agents, two worktrees, each claiming different files, both merging into integration branch, gate runs.

### Phase 4: The Orchestrator

**Goal:** Automatic task decomposition, agent spawning, and integration pipeline.

13. Build task decomposition — orchestrator takes a mission description, uses LLM to break it into subtasks and assign roles from the catalog.
14. Build the spawn loop — orchestrator reads catalog, spawns agent instances, hands them mandates and briefing context.
15. Build `request_capability` — agent says "I need someone who does X", orchestrator looks up catalog, spawns it (or falls back to generic worker + emits `capability.unmatched`).
16. Build the integration pipeline — agent signals DONE → merge worktree → run gate → success, or route failures back as `BLOCKED_ON`.

### Phase 5: Rooms and Decisions

**Goal:** Multi-party negotiation with structured outputs.

17. Build rooms — ephemeral, scoped, with turn budgets, designated asker, and exit conditions.
18. Build decision records — structured output of rooms, injectable into other agents' contexts.
19. Build orchestrator arbitration — when a room hits its turn budget, orchestrator steps in, decides, and writes the record.

### Phase 6: Safety and Failure Handling

**Goal:** The system fails gracefully instead of burning tokens.

20. Spawn caps — max agents, max depth, registry-check-before-spawn.
21. Deadlock detection — cycle detection on wait-for graph, timeouts, watchdog kills youngest.
22. Agent failure handling — crash detection, lease release, respawn with failure context or reassign work.
23. Cold-start briefing — late-spawned agents get decision records + mandate, not full history.

### Phase 7: Trace Viewer

**Goal:** A local web app that makes the trace debuggable.

24. Build the local web viewer — reads from SQLite. Swimlanes, causal DAG, roster timeline.
25. Build replay — key on `llm.request` hashes for deterministic re-execution.
26. Content-address payloads — hash, deduplicate, ~10x storage reduction. Diffing two turns' context becomes diffing two hash lists.

### Phase 8: Polish

**Goal:** Production-quality CLI and safety.

27. CLI with human-in-the-loop — approve final merges, watch room progress, intervene in stuck rooms. Fully autonomous mode available.
28. Sandbox documentation — Docker and micro-VM patterns for autonomous runs.
29. Global caps — wall time, token budget, repair round limits enforced at the mission level.

---

## First Milestone

Phases 1–3. Once two agents can each work in their own worktree, talk to each other, respect file claims, merge their work, and pass a verification gate — the core loop works. Everything else layers on top.
