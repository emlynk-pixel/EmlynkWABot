
# Automatic Agent Delegation Policy

## Mandatory Task Assessment

Before responding to any user task, assess whether specialized agent assistance is appropriate.

- Automatically identify suitable agents from all available personal and project-specific agents.
- Never require the user to mention or select agent names.
- When a task matches a specialist's expertise, delegate the relevant work to that agent.
- For complex tasks, use multiple suitable agents and parallel delegation where possible.
- Allow delegated agents to inspect, implement, test, review and document according to their assigned responsibilities and permissions.
- The main session acts as the orchestrator: it plans the work, delegates tasks, reviews results and provides the final response.
- Do not unnecessarily perform specialized work in the main session when a suitable agent is available.
- Do not invoke agents for simple conversational questions or tasks that do not benefit from delegation.
- Never claim an agent was used unless it was actually invoked.

## Execution

1. Understand the user's request.
2. Identify the relevant technical areas.
3. Select suitable available agents automatically.
4. Delegate tasks without asking the user to name agents.
5. Review delegated results.
6. Combine results and report completion, including any failures.
