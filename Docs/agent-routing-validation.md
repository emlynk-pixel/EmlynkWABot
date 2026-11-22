# Agent Routing Validation Report

Date: 2026-11-22
Scope: validation only. No application code, agent configs, CLAUDE.md, permissions, hooks or settings were changed.
Method: fresh non-interactive sessions (`claude -p --output-format stream-json --verbose --session-id <new uuid>`). Routing requests did not name agents. Agent selection and models were read from the session transcript (`Agent`/`Task` tool calls) and from subagent transcripts plus their `.meta.json` (`agentType`, `model`). Agent self-reports were not used as evidence.

## Verdict: **Not Validated**

Routing does not work as CLAUDE.md specifies. In 5 of 5 organic runs the main session did the work itself and never delegated. The delegation mechanism itself works: when an agent is named in a control check, the subagent is launched and its model is recorded correctly. Those controls validate the per-agent model defaults. They do not validate automatic routing.

## Organic routing tests (no agent named)

| # | Test | Session | Agent selected | Actual model(s) | Result |
|---|------|---------|----------------|-----------------|--------|
| 1 | High-risk RBAC/DB: restrict team-lead reassignment to Super Admin + audit table migration (analysis only) | `71530b8e-fa5d-41df-9b85-a8b79a957634` | None. Main session ran Grep, Glob, Bash itself | Main: Haiku. No subagent | **FAIL**. Expected analyst then backend specialist (Opus). Policy says high-risk must be delegated before analysis or implementation. |
| 2 | OCR: passport misclassification and MRZ date century bug (analysis only) | `ab4e5fb0-8f17-4768-8b71-edbcd48f1e4e` | None. Main session ran Grep, Bash, Read | Main: Haiku. No subagent | **FAIL**. Expected `emlynk-ocr-specialist` (Sonnet). |
| 3 | Complex debugging: intermittent duplicate candidates and misattached documents (root-cause only) | `43bc930a-6549-4868-8cdf-84397c6fb5dc` | None. Main session ran Read, Grep, Glob, Bash itself | Main: Haiku. No subagent | **FAIL**. Expected debugging delegation. The Opus override was not observed. |
| 4 | Simple documentation: summarise the `e2e/` folder (reply only) | `76719eef-7bc3-4e11-aa64-ce4d9b6a9a13` | None. Main session answered after Read and Glob | Main: Haiku. No subagent | **FAIL (routing)**. Haiku was used, but by the orchestrator, not through `emlynk-project-analyst` with the Haiku override the table specifies. |
| 5 | Routine backend implementation: read-only admin endpoint counting candidates by status, with a unit test. Run in a disposable copy of the repo | `bd74b5be-31f6-429c-84ba-576f2d616de5` | None. No analysis step, no `emlynk-backend-specialist`. Main session wrote and edited files itself (2 Write, 5 Edit, 21 Bash) | Main: Haiku. No subagent | **FAIL**. Expected analyst pre-check (per the requirement) and then backend specialist (Opus). |

## Mechanism controls (agent named on purpose; not routing tests)

| Control | Session | Subagent launched | `agentType` | Actual model (subagent meta) | Result |
|---------|---------|-------------------|-------------|------------------------------|--------|
| C1 | `27f12dce-93ab-438d-ab38-4d63742e4a2b` | Yes | `emlynk-project-analyst` | `claude-sonnet-5-5` (default) | PASS (mechanism and default model) |
| C2 | `e59793e3-907b-43b9-8216-60992df4e4d0` | Yes | `emlynk-backend-specialist` | `claude-opus-5-5` (default) | PASS (mechanism and default model) |
| C3 | `ec0d1bfe-3ad2-4529-9cdd-8ec31b95bedc` | Yes | `emlynk-ocr-specialist` | `claude-sonnet-5-5` (default) | PASS (mechanism and default model) |

## Checks and limitations

- **Policy is loaded in `-p` mode.** A no-tool probe asked whether the routing policy was in context and got "YES", quoting the `Task-to-Agent Routing Table` heading. The project agents were also listed in the session's agent types. The transcript itself does not record injected CLAUDE.md text, so the probe answer is the evidence here. The probe is weaker than a transcript record.
- **Sandbox trust.** The routine-backend test ran in a disposable copy (`scratchpad/routing/sandbox`) because it needed edits. Claude Code treated that folder as untrusted and ignored the project `permissions.allow` list. Agent types were still listed, and the Task tool was present. CLAUDE.md was not separately verified in the sandbox. The real working tree was checked after the run and was unchanged.
- **Analysis-only wording.** Tests 1–3 asked for analysis only, which may have lowered delegation. Test 5 used implementation wording and still did not delegate, so the failure is not explained by wording alone.
- **Policy inconsistency.** CLAUDE.md step 2 requires analyst pre-analysis only for high-risk or multi-domain tasks. The validation requirement expects analyst pre-analysis for routine backend work too. This report follows the requirement and flags the mismatch. It needs a decision.
- **Not tested.** The Haiku per-call override on documentation tasks and the Opus override on debugging were not exercised, because no delegation happened to carry them. The analyst's Opus override for complex architecture was not tested either.
- **Rate limits.** None. Every `rate_limit_event` was `status: "allowed"` at 0–2% utilization. No test is BLOCKED.
- **Repeats.** Each organic test ran once. Results are not statistically robust, but five consecutive misses with delegation working in controls is a strong signal.

## Transcript locations

Session transcripts: `C:\Users\Shamal Sathsara\.claude\projects\c--Users-Shamal-Sathsara-OneDrive-Desktop-EmlynkWABot\<session-id>.jsonl`. Subagent transcripts and meta: `...\<session-id>\subagents\`. The sandbox run (test 5) is under the scratchpad project folder.

## Recommended next steps

1. Decide whether routing should be enforced by the orchestrator prompt, by the CLAUDE.md table, or by a hook. Today it is advisory only.
2. Resolve the analyst pre-analysis scope (high-risk only, or all backend work).
3. Re-run tests 1–5 after any change, and add the Haiku and Opus override tests.

---

# Routing Fix and Post-Change Validation

The section above is the original validation record and is kept unchanged. This section documents the fix and its re-validation.

## Root cause of the five failures

The Agent tool's own instructions say "Do not spawn agents unless the user asks… Only use this tool when the user explicitly says to use a subagent, or names one of the available agent types." CLAUDE.md said the opposite ("must delegate"), but without an explicit user request the model followed the tool rule. A no-tool probe (`-p` session, fresh) confirmed this: the model quoted the Agent-tool rule, called the two sources a conflict, and said it would not spawn agents unless asked. Routing had no trigger that outweighed the tool rule, so every organic run stayed in the main session. Named-agent controls worked because the user request was explicit.

## Changed files

- `CLAUDE.md` only. Added two sections after "Core Principle": **Standing Delegation Authorization** (the user's explicit standing request for delegation, which is the trigger the Agent tool requires) and **Delegation Decision** (eight ordered steps mapping task types to agents, per-call model rules, and the main-session boundary).
- No agent files, settings, permissions, hooks, MCP config or application code were changed. Model defaults are unchanged: backend `opus`, frontend `sonnet`, OCR `sonnet`, analyst `sonnet`. Frontmatter is well-formed (`---` at lines 1 and 6 in each agent file).

## Post-change organic runs (same prompts as above, no agent named, fresh `-p` sessions)

| # | Test | Session | Agent invoked | Actual model (subagent meta) | Result |
|---|---|---|---|---|---|
| 1 | High-risk RBAC/DB (analysis only) | `d21f1f51-9456-45c2-9287-221ff15fc9b0` | `emlynk-project-analyst`, per-call `model: opus` | `claude-opus-5-5` | PASS. Implementation specialist not spawned because the request was analysis only |
| 2 | OCR (analysis only) | `6d06a00c-4889-4302-ba47-4645d36b037b` | `emlynk-ocr-specialist`, default | `claude-sonnet-5-5` | PASS |
| 3 | Complex debugging (root cause, analysis only) | `a99d8f24-1e3d-46e0-aeee-4eba4786089e` | `emlynk-project-analyst` (opus) and `emlynk-backend-specialist` (opus) | `claude-opus-5-5` for both | PASS. Opus override is justified for race-condition analysis |
| 4 | Simple documentation (reply only) | `067be798-285a-48ff-be18-5c36952cc4a2`, repeat `5d1777b9-84e3-46b7-b4ec-3e30a4fcdc67` | None. Main session, Read and Glob only | `claude-haiku-5-5` (main) | **FAIL against CLAUDE.md row 6** (spawn analyst with Haiku). Consistent across both runs. **PASS against the task table** ("main session or documentation task with Haiku"). See the divergence below |
| 5 | Routine backend implementation (sandbox copy) | `0b3e693b-5d52-4c6e-a2b7-36531bed46f2` | `emlynk-backend-specialist`, default. No analyst step | `claude-opus-5-5` | PASS. The subagent made all 5 Edit and 1 Write calls. The main session ran only Bash, Read and the Agent call |

Notes on test 5: the sandbox was an untrusted workspace, so Claude Code ignored its project `permissions.allow` list. Agents and the Task/Agent tool were still available. The real working tree showed no new changes.

## Verdict: Partially Validated

- Organic delegation now happens for 4 of 5 scenarios, with correct agent selection and the expected model on every delegated call. Model metadata was read from the subagent transcripts, not from agent claims.
- Scenario 4 is not resolved by the rule text. The task table allows the main session on Haiku, and CLAUDE.md row 6 requires the analyst. I did not change row 6 after seeing the result, because that would move the goalposts. Deciding which reading is correct is a decision for you.
- Each organic scenario ran once, except scenario 4, which ran twice. Routing results have not been checked for stability across repeats. Frontend routing has no organic test yet.
- Enforcement relies on the model accepting the standing authorisation over the Agent tool's rule. That is an instruction, not a guarantee. If it regresses, the next stronger option is a `UserPromptSubmit` hook. I did not add one because hooks are out of scope for this task.
- No routing parity test exists in the repo. The only test script (`node --test test/**/*.test.js`) covers application code, which this change did not touch.

---

# Scenario 4 Resolution and Final Focused Validation

The sections above are unchanged. This section records the next round.

## Scenario 4 decision

Simple documentation does not need specialist delegation. The main session handles it on Haiku when appropriate, and `emlynk-project-analyst` is not invoked for simple documentation. This matches the task's routing table ("Main session or documentation task with Haiku override where appropriate").

## Exact documentation changes (`CLAUDE.md` only)

1. Delegation Decision, step 6. Was: "spawn `emlynk-project-analyst` with `model: "haiku"`." Now: "handle in the main session on `haiku` when appropriate. Do not spawn `emlynk-project-analyst` for simple documentation."
2. Task-to-Agent table, Documentation row. The agent column was changed from "`emlynk-project-analyst`" to "Main session for simple documentation (no delegation); `emlynk-project-analyst` for lightweight analysis". The default-model cell now reads "`sonnet` (analyst)". The Haiku override note now reads "for simple documentation & lightweight notes handled in the main session". The row's scope is otherwise unchanged. Lightweight analysis still goes to the analyst.

No other routing rules were changed. Agent files, model defaults, settings, hooks, permissions, MCP and application code were not changed.

## Focused validation (fresh non-interactive sessions, no agent named)

| # | Scenario | Session | Agent invoked | Actual model (subagent meta or main transcript) | Result |
|---|---|---|---|---|---|
| 1 | Simple documentation (3-sentence note on `test/`, reply only) | `6364fb55-942c-4db6-b673-87f094bd295e` | None. Main session Glob and Bash only | `claude-haiku-5-5` (main) | PASS |
| 2 | Frontend implementation (empty-state message on Candidates page, sandbox) | `8a4bec76-6110-4823-ade2-a8f42abcda15` | None. Main session made 2 Edits itself (`CandidatesPage.tsx` and a test) | `claude-haiku-5-5` (main) | **FAIL**. Specialist not invoked |
| 2b | Frontend repeat (same prompt, fresh sandbox) | `4c0cb069-ae05-49bc-98b3-6ec6920e1232` | None. Main session made 3 Edits itself | `claude-haiku-5-5` (main) | **FAIL**. Same result |
| 3 | Routine backend implementation (candidates-by-status endpoint, sandbox) | `524f74ca-1cad-421a-a430-962077402a15` | None. Main session made 3 Writes and 2 Edits itself. Run hit the 590 s timeout | `claude-haiku-5-5` (main) | **FAIL**. Regression: the same prompt delegated in the earlier run `0b3e693b-…` |
| 3b | Routine backend repeat (fresh sandbox, no timeout) | `19a64ea1-bcb3-4a31-8a23-28d548f101c3` | `emlynk-backend-specialist`, per-call `model: sonnet` | `claude-sonnet-5-5` (subagent meta) | PASS. The Sonnet override is allowed for routine work in the table. Earlier Opus default run `0b3e693b-…` also passed |
| 4 | OCR task (unit test for MRZ two-digit year rule, sandbox) | `45a496a2-fb12-4691-9908-6a0d77d7ba07` | `emlynk-ocr-specialist`, default | `claude-sonnet-5-5` (subagent meta) | PASS |

Notes: the sandbox was an untrusted workspace, so project permission allow-lists were ignored. Agents and Task/Agent tools were still available. Three of the four focused runs ran in parallel, and the backend run timed out only under that load and its own test run. The backend repeat ran alone and without a timeout.

## Stability checks

| Scenario | Session | Agent invoked | Actual model | Result |
|---|---|---|---|---|
| High-risk RBAC/DB (repeat of test 1) | `be82eb15-78da-4ab1-af00-4b274dda0dbb` | `emlynk-project-analyst`, per-call `model: opus` | `claude-opus-5-5` (subagent meta) | PASS for delegation. No implementation specialist, because the request was analysis only |
| Complex debugging (repeat of test 3) | `668280c3-5094-4e56-a5fc-d4466134e0a9` | `emlynk-project-analyst`, per-call `model: opus`. No backend specialist | `claude-opus-5-5` (subagent meta) | **FAIL** on the strict reading of rule 5 ("relevant specialist"). The delegation and Opus model are correct. The first debugging run also used the backend specialist, so routing varies between runs |

## Cumulative status against the required scenarios

| Scenario | Evidence to date | Status |
|---|---|---|
| 1. Simple documentation (main session, Haiku) | `6364fb55` PASS, plus the earlier runs | PASS |
| 2. Frontend implementation (specialist, Sonnet) | `8a4bec76` FAIL, `4c0cb069` FAIL | **FAIL** (2 of 2) |
| 3. Routine backend implementation (specialist) | `0b3e693b` PASS, `19a64ea1` PASS, `524f74ca` FAIL | PASS, 2 of 3 |
| 4. OCR (specialist, Sonnet) | `45a496a2` PASS (one run) | PASS, 1 run only |
| Stability: high-risk RBAC | `d21f1f51` PASS, `be82eb15` PASS | PASS (2 of 2) |
| Stability: complex debugging | `a99d8f24` PASS (analyst + backend, Opus), `668280c3` FAIL (analyst only) | Mixed (1 of 2 on strict reading) |

## Hypotheses not yet tested

- The model may treat the frontend empty-state edit as a "small edit" (rule 7). The two frontend runs edited two files, so this does not fully explain the failure. A stronger test would use a larger, clearly multi-file frontend change.
- Rule 5 may be read loosely, so "relevant specialist" may be satisfied by the analyst alone. The rule text could be tightened, but the instruction is to stop and report before adding more rules.

## Verdict: Partially Validated

- Validated: high-risk RBAC delegation (2 of 2), OCR delegation to the specialist on Sonnet (1 run), simple documentation in the main session on Haiku (1 run), and routine backend delegation (2 of 3).
- **Not validated: frontend implementation.** It failed in both runs, and no frontend specialist was invoked in any organic run. This is a reliable gap, not noise.
- Complex debugging is mixed (1 of 2 on the strict reading).
- Not "Fully Validated": frontend fails and debugging is not stable. Backend is intermittent. OCR has one run only.

## Smallest remaining enforcement option

The instruction-level fix has now been tried twice for frontend and gives no effect there. The smallest remaining option is a `UserPromptSubmit` hook that adds a routing reminder or a checklist to each prompt. It was not added in this round because the task excluded hooks. Any change to settings or hooks needs your explicit approval.

## Untested or limitations

- Repeat counts are small: 1–3 runs per scenario.
- No organic test covers a large multi-file frontend change, or a multi-specialist task (backend plus frontend).
- Analysis-only prompts do not show whether specialists would be invoked for implementation in the real tree.
- Sandboxes were untrusted, so project permission allow-lists did not apply. Agents and tools were still available.
- Test 3's timeout came from load and the test run, not from the routing decision itself.
- `Docs/agent-routing-validation.md` is untracked. Nothing was staged, committed or pushed.
