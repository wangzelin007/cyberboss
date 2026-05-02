# Copilot Code Review Instructions

## Project Context
- Node.js >=22, CommonJS (`require`/`module.exports`)
- Tests: `node:test` + `node:assert/strict` (no external test frameworks)
- Single-user personal agent bridging WeChat ↔ AI runtimes (codex, claudecode, copilot)

## Review Focus
- **Security**: No credentials, tokens, or secrets in code. WeChat tokens and API keys must come from env vars or encrypted config.
- **Error handling**: All async operations should handle failures gracefully. Never crash the main process.
- **No unnecessary dependencies**: Prefer Node.js built-in modules. New `npm` dependencies require justification.
- **Backward compatibility**: Config changes must have sensible defaults. Existing deployments should not break.

## Style
- No TypeScript, no ESM — CommonJS only.
- Prefer `const` over `let`. No `var`.
- Use `node:` prefix for built-in modules in new code (e.g. `require("node:fs")`).
- Keep functions small and focused. Extract helpers when a function exceeds ~80 lines.

## Testing
- Every new feature should include tests in `test/*.test.js`.
- Tests must be deterministic — no network calls, no reliance on system clock.
- Mock external dependencies by injecting `appLike` objects (existing pattern).

## Out of Scope
- Do not comment on formatting or whitespace — there is no auto-formatter configured.
- Do not suggest migration to TypeScript or ESM.
