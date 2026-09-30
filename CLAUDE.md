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

Status: MVP. `/ask`, thread follow-ups and `/oracle-info` work. Planned next:
@mention entry point, Docker image, an evals harness, and turning `path:line`
citations into GitHub links. Keep this file in sync with the code: if a change
alters the layout or conventions below, update this file in the same change.

## Tech stack

- TypeScript (strict), Node.js ≥ 22, ESM modules
- `discord.js` v14 for Discord
- `openai` npm SDK, with `baseURL` from config. Use only the Chat Completions API
  with `tools`, because local servers widely support it (do **not** use the Responses API
  or other OpenAI-only features).
- `zod` to validate configuration and tool arguments
- `pino` for structured logging
- `vitest` for tests, `eslint` + `prettier` for linting and formatting
- `git` on the PATH for repo sync. ripgrep comes bundled via `@vscode/ripgrep`
  (use its `rgPath`, not a system `rg`).
- `make` and a C++20 compiler to build the player rules; `node-html-markdown`
  converts them to Markdown.

## Commands

```sh
npm install
npm run dev                 # tsx watch src/index.ts
npm run build               # tsc -> dist/
npm start                   # node dist/index.js
npm test                    # vitest run
npm test -- test/tools      # run a subset
npm run lint                # eslint .
npm run format              # prettier --write . (markdown is excluded)
npm run typecheck           # tsc --noEmit
npm run register-commands   # push slash command definitions to Discord
npm run ask -- [--variant x] [--no-sync] "question"   # agent without Discord
npm run eval -- [--only <id>] [--tier hard] [--sync]  # answer-quality evals (slow, uses the LLM)
```

Before calling a task done, run `npm run typecheck && npm run lint && npm test`
and `npx prettier --check .`.

## Architecture

```
src/
  index.ts              entry: load config, sync repo, start Discord client
  cli.ts                `npm run ask`
  config.ts             zod schema for all env vars; the only place process.env is read
  logger.ts
  oracle.ts             Oracle: system prompt + agent + concurrency limit; used by CLI and Discord
  discord/
    client.ts           discord.js client (intents, allowedMentions: none)
    commands.ts         slash command definitions (/ask, /oracle-info)
    register.ts         script behind `npm run register-commands`
    handlers.ts         /ask, /oracle-info and thread follow-ups -> Oracle
    format.ts           message splitting, footer, question header, thread name <-> variant
    history.ts          rebuilds conversation turns from a Discord thread
    rateLimit.ts        per-user sliding window
  llm/
    client.ts           LlmClient interface + OpenAI SDK implementation
    agent.ts            tool-calling loop (the core of the bot)
    limiter.ts          FIFO semaphore for LLM_MAX_CONCURRENT
    glossary.ts         finds all-caps game abbreviations (SSTO, BALR) in the question
    callMemory.ts       loop guard: detects repeated tool calls and re-reads of covered ranges
    prompts.ts          system prompt + Atlantis codebase hints
  repo/
    sync.ts             GameRepo: clone, fetch + hard reset, commit, variant discovery
    paths.ts            resolves and sandboxes paths inside GAME_REPO_DIR
  rules/
    build.ts            builds rules HTML: git archive -> make GAME=<v> -> <v> genrules,
                        then compiles and runs native/compendium.cpp against the engine objects
    compendium.ts       compendium output -> "# Compendium" Markdown appendix
    markdown.ts         rules HTML -> Markdown, heading extraction
    store.ts            RulesStore: per-variant rules (+ compendium), cached per commit and
                        FORMAT version, snapshot fallback
  evals/
    score.ts            eval question schema and fact-recall scorer
    run.ts              `npm run eval`: asks evals/questions.json, writes data/evals/*.json
  tools/
    index.ts            registry, OpenAI tool schemas (z.toJSONSchema), runTool
    types.ts            Tool, ToolError, truncate
    searchCode.ts       ripgrep wrapper
    readFile.ts         read a line range
    listDir.ts
    rules.ts            search_rules, read_rules
    gamedata.ts         parser for gamedata.cpp tables and gamedata.h enums
    findDefinition.ts   looks up a table entry by name, abbreviation or enum constant
native/
  compendium.cpp        prints the engine's player-facing descriptions (ItemDescription,
                        ShowSkill::Report, ObjectDescription) for every enabled entry
evals/questions.json    eval questions with fact regexes and ground truth
test/                   mirrors src/; helpers/ has the fixture path and a scripted fake LLM,
                        fixtures/game-repo/ is a tiny fake Atlantis repo
```

### Request flow

1. `discord/handlers.ts` receives `/ask` or a message in a bot-owned thread. It
   checks the channel allowlist and the rate limit. For `/ask` it calls
   `deferReply()` right away (Discord gives only 3 seconds before the interaction
   expires), edits the reply into a question header and starts a thread from it.
   The thread name ends in ` · <variant>`, so follow-ups need no stored state.
2. For follow-ups, `discord/history.ts` rebuilds the turns from the thread's
   starter message and its last 20 messages. `oracle.ts` adds the system prompt
   (repo, commit, selected variant, whether rules exist, and a note that expands
   abbreviations found by `llm/glossary.ts`, e.g. `SSTO = skill "summon storm"`) and takes an
   `LLM_MAX_CONCURRENT` slot.
3. `llm/agent.ts` runs, in order: an optional **plan** call without tools
   (`LLM_PLAN_STEP`: the model lists the facts it needs and where to find them),
   the research loop, and an optional **review** call without tools
   (`LLM_REVIEW_STEP`: the model checks the draft against the tool results and
   replies `APPROVED`, a revised answer, or `RESEARCH: …`, which buys one more
   research loop of up to 6 rounds). In the research loop, **rules first:** until the model has called a
   rules tool (`firstTools`), only the rules tools are offered. Code tool calls
   are refused, and an answer without any lookup gets one reminder. After that,
   all tools are offered. Otherwise the loop calls the model with `tools`, runs any
   requested tool calls, appends the results, and repeats until the model
   returns a final answer or `LLM_MAX_TOOL_ITERATIONS` is reached. When the cap
   is hit, it makes one last call without tools to force an answer from what
   has been gathered.
   Total tool output per question is capped (`LLM_TOOL_OUTPUT_BUDGET`, default
   60k characters) to protect small context windows. If an LLM call fails
   mid-research (e.g. a timeout on a huge context), the agent shortens the tool
   results and forces an answer from them instead of failing the question. A
   failed plan or review call is skipped. Every call sends `max_tokens`
   (`LLM_MAX_TOKENS`); a research reply cut off before any answer gets one
   "answer concisely" retry. When 4 or fewer research rounds remain, the last
   tool result of each round tells the model how many are left.
   Each LLM call is recorded (`llmCalls`: purpose, time, prompt/cached/completion
   tokens, truncation, error); failures throw `AgentError` with the partial record. A call that repeats an earlier successful one (same tool and
   arguments, or a `read_file`/`read_rules` range inside an earlier read) gets a
   short "already shown in step N" note instead, which costs no budget.
4. While the agent works, `handlers.ts` keeps a progress message up to date
   (throttled to one edit per 3s; the steps are described by
   `format.describeToolCall`) and deletes it when the answer is posted. The
   answer is split by `format.ts` into several messages if needed, with a `-#` footer (model, variant, repo@commit). `history.ts` strips
   the footer when it rebuilds context.

`oracle.ts` and everything under `llm/`, `tools/` and `repo/` must not depend on
Discord. `cli.ts` and the tests drive them directly.

## Tools exposed to the LLM

Keep the tool set small and orthogonal. Each tool has a zod schema for its
arguments, a JSON schema derived from it, a clear description (the model reads
it), and a handler that returns **plain text**.

| Tool | Purpose |
|---|---|
| `search_rules` | regex/literal search in the variant's rules Markdown, including the `# Compendium` appendix (engine descriptions of every monster, item, skill/spell and building, headed `name [ABBR]`); results grouped by section trail (`Skills > Studying`) |
| `read_rules` | table of contents (no args), a section by heading or trail, or a line range |
| `search_code` | ripgrep for a regex/literal, optional path glob; returns `path:line: text` with limited context |
| `read_file` | read `path` from `start_line` to `end_line` (default 150, max 300 lines per call) |
| `list_dir` | list a directory within the repo |
| `find_definition` | look up one or more (`queries`, max 25) items, skills, objects, terrain etc. in `gamedata.cpp` by name, tag or enum (e.g. `TACT`, `plate armor`, `I_PLATEARMOR`). Reports the enum constant, "disabled by default" status and the lines in `<variant>/extra.cpp` that change the entry; full entries with the field legend for up to 4 matches, one summary line each beyond that |

Rules for tools:

- **Sandboxing:** every path goes through `repo/paths.ts`. It rejects absolute
  paths, `..` escapes and symlinks that resolve outside `GAME_REPO_DIR`. Tools
  only read.
- **Executing game code:** the only thing that runs code from the game repo is
  the rules build: `make`, `genrules`, and `native/compendium.cpp` linked against
  the engine objects. The bot triggers it after a sync, never the LLM. It runs on an export under `RULES_DIR/build`, and it means the
  operator must trust `GAME_REPO_URL`. Never give the LLM a way to trigger
  builds or run commands.
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
  `temperature`, `top_p` (only when `LLM_TOP_P` is set), `max_tokens`. The one
  non-OpenAI field, `chat_template_kwargs.enable_thinking`, is sent only when
  `LLM_THINKING` is `off` or `final`. On oMLX with Qwen3.8 it cut a trivial
  question from 89s and 1,500 tokens (cut off) to 3s and 42 tokens; the `/no_think`
  prompt switch and a top-level `enable_thinking` were ignored. No `response_format` JSON schema, no
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

Upstream layout, verified against Atlantis-PBEM/Atlantis `master` and `stable`.
Upstream's default branch `master` is stale; active development is on `stable`.
The two differ in places:

- `gamedata.cpp` holds the core data tables: `ItemDefs`, `ManDefs`, `MonDefs`,
  `WeaponDefs`, `ArmorDefs`, `MountDefs`, `BattleItemDefs`, `SkillDefs`,
  `ObjectDefs`, `TerrainDefs`, `SpecialDefs`, `EffectDefs`, `AttribDefs`, and
  more. Skills and items are referred to by short tags such as `"TACT"` or
  `"COMB"`. On `master` the tables are `std::vector<ItemType> ItemDefs = {…}`;
  on `stable` they are C arrays with an alias (`ItemType id[] = {…}` and then
  `ItemType *ItemDefs = id;`). `tools/gamedata.ts` parses both. Entry order
  matches the anonymous enums in `gamedata.h` (`I_*`, `S_*`, `O_*`, `R_*`).
- `<variant>/rules.cpp` holds the variant's `GameDefs` constants (speeds, costs,
  limits) and faction-point tables (`allowedMages`, `allowedTaxes`, ...).
- `<variant>/extra.cpp` holds `Game::ModifyTablesPerRuleset()`, which
  enables, disables or modifies items, skills and objects for that variant
  (`EnableItem`, `EnableSkill`, `ModifyItem...`). **The effective rules for a
  variant are `gamedata.cpp` + these modifications.**
- `<variant>/world.cpp`, `map.cpp`, `monsters.cpp` handle world generation and monsters.
- Variants: `basic`, `standard`, `fracas`, `havilah`, `kingdoms`, `neworigins`.
  `unittest/` also has a `rules.cpp` but is a test harness; `discoverVariants`
  skips directories whose name contains "test".
- Engine logic (how orders resolve): `parseorders.cpp`, `runorders.cpp`,
  `monthorders.cpp`, `battle.cpp`, `army.cpp`, `economy.cpp`, `production.cpp`,
  `market.cpp`, `spells.cpp`, `specials.cpp`, `unit.cpp`, `faction.cpp`.
- Player-facing rules: `genrules.cpp` generates the rules HTML from the data
  (`<variant> genrules <intro> <css> <out>`). The bot builds them itself with
  the plain `Makefile`. The CMake build doesn't work with CMake 4
  (`CompilerSupport.cmake` uses `EQUALS`), and on macOS `stable` needs
  Atlantis-PBEM/Atlantis#299. `master` also has committed copies in
  `snapshot-tests/rules/<variant>.html`, used as the fallback; `stable` has
  none. The rules don't describe monsters or spells; the compendium, generated by
  the engine's own report functions, covers those. Illusions share their monster's
  name and abbreviation in `ItemDefs`, so the compendium lists them separately as
  `illusory <name> [I<ABBR>]`. Keep the upstream compiler flags: e.g. `-O1` breaks the link, because
  `Faction::gets_gm_report` is declared `inline` in a `.cpp`.

The agent should also work when `GAME_REPO_URL` points at a fork with a different
layout. Present these hints as "likely locations", not certainties, and keep
them in one place (`llm/prompts.ts`).

## Answer style (enforced in the system prompt)

- Answer from what the tools returned, not from general knowledge of other
  Atlantis versions. If the repo doesn't settle a question, say so.
- Short and to the point, unless the player asks for details.
- Write for players, not C++ programmers. Explain the effect first, then the
  supporting detail. Quote code only when it helps.
- Sources go in a separate part at the end of the answer, not inline: rules as
  `rules § <section>`, code as `path:line`. `discord/format.ts` may turn these
  into GitHub links using the repo URL and the current commit.
- Never explain loopholes or code flaws that players could exploit; the review
  step checks this too.
- Harder question types have playbooks in the prompt ("what does it take to
  beat X", "is order X enough", "what should I consider against X"): Compendium
  numbers plus rules formulas, a worked example with stated assumptions, and
  counters backed by sources.
- Discord markdown only. Do not use headings for short answers.

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
