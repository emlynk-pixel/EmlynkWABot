# Automatic Agent Delegation & Model Routing Policy

## Core Principle
The main session acts as the **orchestrator**: it plans work, automatically selects and delegates tasks to specialized project agents, reviews results, and synthesizes final responses.
- **Automatic Specialist Selection**: Automatically identify and dispatch to the correct specialist based on task domain and technical scope. Never require the user to name or select agents.
- **Do Not Perform Specialized Work in Main Session**: When a task matches a specialist's expertise, delegate the work rather than implementing it directly in the main session.
- **Mandatory Delegation for High-Risk Tasks**: Any task involving RBAC, authentication, security-sensitive logic, database schema changes/migrations, or critical production workflows MUST be delegated to the relevant specialist before any implementation begins. The main session must never directly implement high-risk changes.
- **Multi-Specialist Coordination**: When a task crosses technical boundaries (backend, frontend, OCR), decompose the task and delegate each boundary to its respective specialist.

## Standing Delegation Authorization
The user has explicitly asked for automatic delegation under this policy. For every new request that matches the decision steps below, spawn the listed agent(s) with the Agent tool without waiting for the user to name an agent. This standing request applies to every task in this project, not only when an agent is named.

## Delegation Decision (make before any analysis or edit)
1. **High-risk or multi-domain** (RBAC, auth, security, DB schema/migrations, transactions, critical production workflows, or work spanning backend and frontend/OCR): spawn `emlynk-project-analyst` first, then the relevant implementation specialist(s).
2. **Routine backend implementation** (Express APIs, services, non-critical endpoints): spawn `emlynk-backend-specialist` directly. No analyst step.
3. **Frontend implementation** (`admin/`, `candidate-form/`): spawn `emlynk-frontend-specialist` directly.
4. **OCR implementation or investigation** (`ocr-worker/`, MRZ, classification): spawn `emlynk-ocr-specialist` directly.
5. **Complex debugging**: spawn the relevant specialist. Pass `model: "opus"` only for deep root-cause analysis (race conditions, concurrency, subtle integration failures).
6. **Simple documentation or lightweight notes**: handle in the main session on `haiku` when appropriate. Do not spawn `emlynk-project-analyst` for simple documentation.
7. **Trivial questions and small single-file edits**: handle in the main session; do not delegate.
8. Do not implement rows 1–5 in the main session. Make the decision before the first edit or analysis, and say which agent(s) you chose.

## Task-to-Agent Routing Table

| Task Domain / Scope | Target Specialist Agent | Agent Default Model | Per-Call Model Override |
| :--- | :--- | :--- | :--- |
| **Requirements Analysis & Architecture**<br>Pre-implementation impact analysis, architectural evaluation, dependency tracing, business rule verification | `emlynk-project-analyst` | `sonnet` | • Use **`opus`** for complex architecture & security reviews<br>• Use **`sonnet`** (default) for standard analysis |
| **Documentation & Lightweight Tasks**<br>Simple documentation, README updates, guide updates, lightweight analysis | Main session for simple documentation (no delegation); `emlynk-project-analyst` for lightweight analysis | `sonnet` (analyst) | • Use **`haiku`** for simple documentation & lightweight notes handled in the main session |
| **Routine Backend Development**<br>Express APIs, services, candidate workflows, integrations, non-critical endpoints | `emlynk-backend-specialist` | `opus` | • Use **`sonnet`** for routine implementation & investigation to optimize latency/cost<br>• Use **`opus`** (default) for complex logic |
| **High-Risk Backend & Database**<br>RBAC, authorization, Supabase Auth, security-sensitive logic, database schema/Prisma migrations, transactions | `emlynk-backend-specialist` | `opus` | • Use **`opus`** (mandatory for high-risk changes) |
| **Frontend Development**<br>React 19 Admin Dashboard (`admin/`), Candidate Form (`candidate-form/`), components, forms, UI styling | `emlynk-frontend-specialist` | `sonnet` | • Use **`opus`** for high-risk frontend auth / complex state<br>• Use **`sonnet`** (default) for standard UI implementation |
| **OCR & Document Processing**<br>OCR worker (`ocr-worker/`), Tesseract, MRZ/passport extraction, document classification | `emlynk-ocr-specialist` | `sonnet` | • Use **`opus`** for high-risk extraction algorithms / complex worker debugging<br>• Use **`sonnet`** (default) for normal OCR changes |
| **Complex Debugging**<br>Root-cause analysis of subtle bugs, race conditions, memory leaks, system integration failures | Relevant Specialist (`backend`, `frontend`, or `ocr`) | Agent Default | • Override with **`opus`** for complex debugging across all domains |

## Model Selection Strategy & Overrides

When invoking an agent using the `Agent` tool, specify the `model` parameter to override the default when the task demands it:

1. **`opus`** (High Complexity / High Risk):
   - Complex architectural design and system refactoring.
   - High-risk debugging, race conditions, and concurrency issues.
   - Security-sensitive logic, authentication, RBAC, and permission enforcement.
   - Difficult database operations, schema redesign, and data integrity migrations.
2. **`sonnet`** (Normal Implementation & Investigation):
   - Standard feature implementation and UI development.
   - Normal API endpoints, services, and middleware.
   - Standard OCR pipeline updates and test maintenance.
   - Codebase exploration, search, and pre-implementation investigation.
3. **`haiku`** (Lightweight & Documentation):
   - Simple documentation writing and markdown editing.
   - Lightweight file searches, grep checks, or quick analysis.

## Execution Workflow

1. **Classify Task & Risk Level**: Assess whether the task is routine, complex, or high-risk (e.g. RBAC, DB schema, security, multi-domain).
2. **Pre-Implementation Analysis (For High-Risk or Multi-Domain Tasks)**:
   - Delegate first to `emlynk-project-analyst` to trace affected files, dependencies, and risks.
3. **Automatic Delegation**:
   - Dispatch the implementation task to the appropriate specialist (`emlynk-backend-specialist`, `emlynk-frontend-specialist`, or `emlynk-ocr-specialist`).
   - If the task spans multiple areas, delegate each part to the respective specialist.
   - Set the `model` parameter explicitly on the `Agent` call when escalation or cost optimization is required (`model: "opus"`, `model: "sonnet"`, or `model: "haiku"`).
4. **Mandatory Rule for High-Risk Tasks**:
   - The main session MUST NOT write or edit code directly for high-risk tasks. Implementation must be performed by the delegated specialist.
5. **Review & Synthesis**:
   - Verify test evidence provided by specialists.
   - Synthesize results, clearly reporting which agents were used and changes made.
