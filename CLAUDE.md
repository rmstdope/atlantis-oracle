# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

**atlantis-oracle** is a Discord bot that answers player questions about the
PBEM game Atlantis. It grounds its answers in a local clone of a game
repository (default: https://github.com/Atlantis-PBEM/Atlantis.git, which can
be changed with `GAME_REPO_URL`). An LLM, reached through an **OpenAI-compatible API**,
drives the answer. It calls repo tools (search/read/list) in a loop and then
writes an answer for the player, with source references.

The LLM backend must stay swappable: hosted OpenAI, or a local server such as
Ollama, llama.cpp, vLLM or LM Studio. This is a core requirement, not an extra
(see "LLM portability" below).

Status: early development. The layout below is the target structure. If the
code differs from it, update this file in the same change.

## Tech stack

- TypeScript (strict), Node.js ≥ 22, ESM modules
- `discord.js` v14 for Discord
- `openai` npm SDK, with `baseURL` from config. Use only the Chat Completions API
  with `tools`, because local servers widely support it (do **not** use the Responses API
  or other OpenAI-only features).
- `zod` to validate configuration and tool arguments
- `pino` for structured logging
- `vitest` for tests, `eslint` + `prettier` for linting and formatting
- External binaries: `git` (repo sync) and `rg` (ripgrep, for code search)

## Commands

```sh
npm install
npm run dev                 # tsx watch src/index.ts
npm run build               # tsc -> dist/
npm start                   # node dist/index.js
npm test                    # vitest run
npm test -- src/tools       # run a subset
npm run lint                # eslint .
npm run typecheck           # tsc --noEmit
npm run register-commands   # push slash command definitions to Discord
npm run ask -- "question"   # CLI: run the agent without Discord (for dev and evals)
```

Before calling a task done, run `npm run typecheck && npm run lint && npm test`.

## Architecture

```
src/
  index.ts              entry: load config, sync repo, start Discord client
  config.ts             zod schema for all env vars; the only place process.env is read
  logger.ts
  discord/
    client.ts           discord.js client setup, intents, event wiring
    commands.ts         slash command definitions (/ask, /oracle-info)
    register.ts         script behind `npm run register-commands`
    handlers.ts         turns interactions/mentions/thread replies into agent calls
    format.ts           splits long answers at 2000 chars, formats source refs
    rateLimit.ts        per-user limiter
  llm/
    client.ts           OpenAI SDK instance built from config
    agent.ts            tool-calling loop (the core of the bot)
    prompts.ts          system prompt + Atlantis codebase hints
    history.ts          rebuilds conversation context from a Discord thread
  repo/
    sync.ts             clone on start, periodic `git pull`, exposes current commit
    paths.ts            resolves and sandboxes paths inside GAME_REPO_DIR
  tools/
    index.ts            tool registry: name -> { zod schema, JSON schema, handler }
    searchCode.ts       ripgrep wrapper
    readFile.ts         read a line range
    listDir.ts
    findDefinition.ts   looks up an item/skill/object entry by name or tag in gamedata tables
  cli.ts                `npm run ask`
test/                   vitest tests; fixtures/ holds a tiny fake game repo
```

### Request flow

1. `discord/handlers.ts` receives `/ask`, an @mention, or a reply in a bot-owned
   thread. It checks the channel allowlist and the rate limit, calls
   `deferReply()` right away (Discord gives only 3 seconds before the interaction
   expires), and creates or reuses a thread.
2. `llm/history.ts` builds the message list: system prompt, prior turns from the
   thread, and the new question, including the selected game variant.
3. `llm/agent.ts` runs the loop: it calls the model with `tools`, runs any
   requested tool calls, appends the results, and repeats until the model
   returns a final answer or `LLM_MAX_TOOL_ITERATIONS` is reached. When the cap
   is hit, it makes one last call without tools to force an answer from what
   has been gathered.
4. `discord/format.ts` posts the answer, split into several messages if needed.

`llm/agent.ts` must not depend on Discord. `cli.ts` and the tests drive it directly.

## Tools exposed to the LLM

Keep the tool set small and orthogonal. Each tool has a zod schema for its
arguments, a JSON schema derived from it, a clear description (the model reads
it), and a handler that returns **plain text**.

| Tool | Purpose |
|---|---|
| `search_code` | ripgrep for a regex/literal, optional path glob; returns `path:line: text` with limited context |
| `read_file` | read `path` from `start_line` to `end_line` (max ~300 lines per call) |
| `list_dir` | list a directory within the repo |
| `find_definition` | find the entry for an item, skill, object, terrain, etc. in `gamedata.cpp`, by name or tag (e.g. `TACT`, `plate armor`) |

Rules for tools:

- **Sandboxing:** every path goes through `repo/paths.ts`. It rejects absolute
  paths, `..` escapes and symlinks that resolve outside `GAME_REPO_DIR`. Never
  run anything from the game repo; it is only read.
- **Output limits:** truncate results to a fixed character budget and say so
  (`[truncated: 212 more matches, narrow your search]`). A small local model's
  context runs out quickly, so this is critical.
- **Errors are results:** a bad regex or a missing file returns an error string to
  the model so it can correct itself. It must not throw out of the agent loop.
- Line numbers in tool output are 1-based and match what `read_file` accepts,
  so the model can follow up precisely.

## LLM portability

- Only depend on features that common OpenAI-compatible servers support:
  `chat.completions.create` with `messages`, `tools`, `tool_choice: "auto"`,
  `temperature`, `max_tokens`. No `response_format` JSON schema, no
  `parallel_tool_calls` flag, no logprobs, no streaming requirement.
- Handle more than one tool call in a response, and also exactly one.
- Tolerate imperfect local models: malformed JSON in tool arguments (return a
  validation error to the model), unknown tool names, empty content next to
  tool calls, and `<think>…</think>` blocks in content (strip them before
  posting).
- Never hard-code model names in logic. The model comes only from `LLM_MODEL`.
- Keep the system prompt and tool descriptions compact. The total prompt
  should fit comfortably in a 32k context, with room left for tool results.

## Atlantis codebase knowledge (for the system prompt and `find_definition`)

Upstream layout, verified against Atlantis-PBEM/Atlantis `main`:

- `gamedata.cpp` holds the core data tables: `ItemDefs`, `ManDefs`, `MonDefs`,
  `WeaponDefs`, `ArmorDefs`, `MountDefs`, `BattleItemDefs`, `SkillDefs`,
  `ObjectDefs`, `TerrainDefs`, `SpecialDefs`, `EffectDefs`, `AttribDefs`, and
  more. Skills and items are referred to by short tags such as `"TACT"` or
  `"COMB"`.
- `<variant>/rules.cpp` holds the variant's `GameDefs` constants (speeds, costs,
  limits) and faction-point tables (`allowedMages`, `allowedTaxes`, ...).
- `<variant>/extra.cpp` holds `Game::ModifyTablesPerRuleset()`, which
  enables, disables or modifies items, skills and objects for that variant
  (`EnableItem`, `EnableSkill`, `ModifyItem...`). **The effective rules for a
  variant are `gamedata.cpp` + these modifications.**
- `<variant>/world.cpp`, `map.cpp`, `monsters.cpp` handle world generation and monsters.
- Variants: `basic`, `standard`, `fracas`, `havilah`, `kingdoms`, `neworigins`.
- Engine logic (how orders resolve): `parseorders.cpp`, `runorders.cpp`,
  `monthorders.cpp`, `battle.cpp`, `army.cpp`, `economy.cpp`, `production.cpp`,
  `market.cpp`, `spells.cpp`, `specials.cpp`, `unit.cpp`, `faction.cpp`.
- Player-facing rules: `genrules.cpp` generates the rules HTML from the data.
  Generated copies are in `snapshot-tests/rules/<variant>.html`, and the
  variant intros are in `<variant>/<variant>_intro.html`. For "how do I play"
  questions these are often the best source, but code is authoritative when the
  two disagree.

The agent should also work when `GAME_REPO_URL` points at a fork with a different
layout. Present these hints as "likely locations", not certainties, and keep
them in one place (`llm/prompts.ts`).

## Answer style (enforced in the system prompt)

- Answer from what the tools returned, not from general knowledge of other
  Atlantis versions. If the repo doesn't settle a question, say so.
- State which variant the answer applies to when variants differ.
- Cite sources as `path:line`. `discord/format.ts` may turn these into GitHub
  links using the repo URL and the current commit.
- Write for players, not C++ programmers. Explain the effect first, then the
  supporting detail. Quote code only when it helps.
- Discord markdown only, and keep answers concise. Do not use headings for short answers.

## Conventions

- Read configuration only through `config.ts`. Other modules receive typed config
  objects, which keeps them testable.
- Use dependency injection instead of module singletons for the OpenAI client,
  repo root and logger, so tests can pass fakes.
- Tests: unit-test tools against `test/fixtures/game-repo/` (a few trimmed
  Atlantis files, not the full repo). Test the agent loop with a scripted fake
  OpenAI client. Tests must not make network calls.
- Log every question with the tool calls made, iterations used, token usage (when
  the server reports it) and latency. Never log the Discord token or the API key.
- Keep the code small. Avoid frameworks, DI containers and embeddings/vector
  DBs unless there is a demonstrated need. The agentic grep approach is a
  deliberate choice.
- Keep `.env.example` in sync with `config.ts`, and keep the configuration
  table in README.md in sync with both.

## Security and abuse

- Channel allowlist and per-user rate limit are on by default. Each question
  costs LLM tokens.
- Treat repo content and user messages as untrusted input to the LLM. The model
  has read-only tools only, so the impact of prompt injection is limited to
  the text of the answer. Keep it that way: add no tools that write, execute
  or fetch URLs.
- Set `allowedMentions: { parse: [] }` on every bot message, so an answer can
  never ping `@everyone` or roles.
