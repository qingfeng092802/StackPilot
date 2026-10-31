<!-- README_SYNC: source=working-tree@1ae6ff7; updated=2026-10-31 -->

<p align="center">
  <a href="./README.md">简体中文</a> · English
</p>

# StackPilot MCP

> For people who write code with Cursor / Claude Code: one plain-language sentence → **a verifiable architecture pick + a runnable skeleton + project rules written straight into your repo**. Every pick, component and version comes from a closed set and measured data — same sentence, same answer, every time.

<p align="center">
  <a href="https://github.com/qingfeng092802/StackPilot/stargazers"><img src="https://img.shields.io/github/stars/qingfeng092802/StackPilot?style=flat&color=yellow" alt="Stars"></a>
  <a href="https://github.com/qingfeng092802/StackPilot/releases/tag/v3.0.0"><img src="https://img.shields.io/badge/version-3.1.0-blue" alt="Version 3.0.0"></a>
  <a href="https://github.com/qingfeng092802/StackPilot/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/qingfeng092802/StackPilot/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/qingfeng092802/StackPilot/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520.11-brightgreen" alt="Node >= 20.11">
  <a href="https://github.com/qingfeng092802/StackPilot/issues"><img src="https://img.shields.io/github/issues/qingfeng092802/StackPilot" alt="Issues"></a>
</p>

**If StackPilot saved you from architecture guesswork and rabbit holes, give it a [Star](https://github.com/qingfeng092802/StackPilot/stargazers) — it helps you find this later, and helps people who got burned by "AI-recommended stacks" find it too.**

---

## Why it exists

Ask an AI "what stack should I use?" and it will confidently hand you a plan — then you hit every pitfall on real machines. We measured that path with 12 architectures × 3 rounds of real generation (AI writes it once → `npm install` → `npm run build`, 2026-10-30, deepseek-flash):

| What asking a bare LLM actually yields | What StackPilot does instead |
|---|---|
| **36 of 39 measured rounds produced zero deployment artifacts** (vercel.json / wrangler.toml / docker-compose); the other 3 only partial | The skeleton ships 100% of deployment config and `.env.example`, every version pinned and traceable to a fact snapshot |
| AI picked `better-sqlite3` (a native module) — **all 3 rounds failed to compile on Windows** | The data layer is pinned to pure-JS `@libsql/client`; in the switch experiment, first-shot success on that combo went **from 0% to 100%** |
| Imported `openai` without declaring it in package.json — `Module not found` at build time | The bootstrap prompt carries "AI generation discipline" distilled from these failures; deterministic templates keep the dependency list and imports consistent |
| Answers you cannot audit — rephrase and you get a different stack | 12-combo closed set with scoring; every conclusion cites the exact words it came from, with a reproducible score |

> 📊 Full data: [eval batch report](docs/eval-batch-2026-10-30-flash-v1.md) (42 rounds, failure taxonomy, attribution — all reproducible).

## Five tools

| Tool | What it does |
|---|---|
| `recommend_stack` | Plain language (or host-extracted structured constraints) → closed-set pick + bootstrap prompt + pitfall alerts; returns a clarification protocol instead of guessing when confidence is low |
| `get_detailed_prompt` | Bootstrap prompt for a chosen combo, no re-ranking |
| `apply_stack_blueprint` | Writes the architecture contract idempotently into `.cursor/rules/stackpilot.mdc` and `CLAUDE.md` — the AI obeys it the moment it opens your project |
| `scaffold_blueprint` | Generates a runnable skeleton: version-pinned package.json, directory layout, `.env.example`, deployment config (never overwrites existing files) |
| `inspect_project` | Read-only audit of an existing repo: closest blueprint, what's missing, what's extra (monorepos are explicitly declined) |
| `deep_architecture_review` | **For complex needs only** (~30s + extra cost, requires a key): three blind perspectives → red-team contradiction pass → judge verdict; out-of-set verdicts are logged as candidates with a measured-discipline manual prompt. Use `recommend_stack` for everyday picks |

Three-stage parsing, **works without any API key**: host-extracted structured constraints (zero cost, preferred) → built-in LLM → offline keyword + Chinese-number rules.

## Quick start

```bash
git clone https://github.com/qingfeng092802/StackPilot.git stackpilot
cd stackpilot
npm install && npm run build   # produces build/mcp.js (single file, zero runtime deps)
npm test                       # 10 regression suites, 452 assertions
npm run mcp:smoke              # real subprocess, JSON-RPC end to end
```

Hook it into Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "stackpilot": {
      "command": "node",
      "args": ["D:/StackPilot/build/mcp.js"]
    }
  }
}
```

Claude Code one-liner: `claude mcp add stackpilot -- node D:/StackPilot/build/mcp.js`.

Then just say: "Use stackpilot to pick an architecture: I want a bookkeeping mini-program, it's just me, needs login." Client notes: **Claude Desktop** needs an explicit `env` block (optionally a DeepSeek key for the LLM path); **WorkBuddy** requires `ANTHROPIC_API_KEY: ""` (its subprocess inherits host credentials and 401s otherwise) plus a manual "trust" in the connector manager. Ask in [Issues](https://github.com/qingfeng092802/StackPilot/issues) if you need a full example.

## Engineering boundaries (the honest part)

- **Closed set of 12 combos**: desktop and complex CLI are explicitly declined, never force-fitted — by design;
- **Determinism red line**: bootstrap prompts and architecture contracts are 100% template-generated; the model only extracts constraints and writes explanations, both gated by local evidence checks;
- **Injection defense**: user input passes high-confidence injection detection first (including XML boundary escapes); matches are stripped and logged;
- **Keyless fallback**: keyword rules + Chinese-number parsing, with the active path labeled in every output;
- **Telemetry off by default**: set `SP_TELEMETRY=1` to write local anonymous stats (no prose, no paths); delete `~/.stackpilot/usage.jsonl` to erase.

Known limits and decision history: [CHANGELOG](CHANGELOG.md), [ROADMAP](docs/ROADMAP-v2.1.md).

## License

[MIT](LICENSE) © StackPilot contributors

---

If this project solved a real problem for you, a [Star](https://github.com/qingfeng092802/StackPilot/stargazers) helps you come back to it and helps others with the same needs find it. Questions and suggestions go straight to [Issues](https://github.com/qingfeng092802/StackPilot/issues).
