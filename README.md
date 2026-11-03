# atlantis-oracle

A Discord bot that answers player questions about the play-by-email game
[Atlantis](https://github.com/Atlantis-PBEM/Atlantis). Its answers come from
the game's source code and generated rules, not from the model's memory.

Ask it things like:

> What does the TACTICS skill actually do in battle?
>
> What do I need to produce plate armor, and which skill level?
>
> Can a unit both MOVE and STUDY in the same turn?
>
> In New Origins, how many mages can my faction have with 3 points in magic?

The bot looks the question up in the player rules, which it builds from the
game source. If the rules don't settle it, it researches the source code. Then
it writes a player-friendly answer that cites the rules sections and files it
used.

> **Status:** MVP. `/ask`, follow-up questions in answer threads, and
> `/collective-info` work. @mentions and a Docker image are planned. See
> [CLAUDE.md](CLAUDE.md) for the architecture and project conventions.

## How it works

```
Discord user ──/ask──▶ Bot ──▶ LLM (OpenAI-compatible API)
                                 │   ▲
                     tool calls  │   │ tool results
                                 ▼   │
             1. Rules tools (search_rules, read_rules)
             2. Code tools  (search_code, read_file, list_dir, find_definition)
                     │                            │
                     ▼                            ▼
     Rules built from the repo       Local clone of the Atlantis repo
     (make + genrules → Markdown)
```

1. A player asks a question with `/ask`.
2. The bot sends the question to an LLM, together with notes on any game
   abbreviations in it (e.g. SSTO = summon storm). The LLM first writes a
   short research plan. Then it gets a set of **tools**, at first only the
   rules tools, so every answer starts from the player rules for the game
   variant.
3. If the rules don't settle the question, the code tools become available.
   The LLM can then search the source, read files, and look up items, skills
   and buildings in the `gamedata.cpp` tables. It keeps going until it has
   enough to answer. With `LLM_LOOKUP_MODE=guide` it also gets a
   [code guide](guides/atlantis-code.md) that maps game topics to the
   functions and tables that decide them (see below).
4. The LLM reviews its draft against what it found. It can approve it,
   correct it, or do one more round of research if something is missing.
5. The bot posts the answer, with source references, in a new thread. Players
   can ask follow-up questions by replying in the thread.

The retrieval is *agentic* (the model calls tools) rather than based on
embeddings. The Atlantis game data mostly lives in large C++ tables where exact
names matter, and plain text search is precise for that. This approach also
works with any OpenAI-compatible server, including ones that don't serve an
embeddings model.

### Code guide

Searching 58k lines of C++ with grep works, but on hard questions a model
can spend a dozen tool calls hunting for the right function. The code guide,
`guides/atlantis-code.md`, is a hand-written map from game topics (hit odds,
spoils, taxing, sailing, ...) to the functions, tables and constants that
decide them, with one line on what each decides. It names symbols rather
than line numbers: after every sync the bot resolves each symbol to
`path:line` in the current checkout, so the pointers stay exact and entries
that no longer exist are reported in the log (`npm run guide:check` prints
them). With `LLM_LOOKUP_MODE=guide` the system prompt lists the topics, a
`read_guide` tool returns a topic's pointers, and the model reads the code at
those lines. The grep tools stay available for anything the guide misses.
The default is `grep`, so the two can be compared with `npm run eval -- --mode guide`.
The guide describes upstream Atlantis; a fork with a different layout needs
its own guide, or grep mode.

### Player rules

On startup, and whenever the game repository changes, the bot builds each
variant with the game's own `Makefile` and runs `<variant> genrules`. That
produces the same rules HTML that players get. The bot converts it to Markdown
under `RULES_DIR`. The build runs on a `git archive` export, so the clone stays
clean. The first build takes a minute or less; after that, rules are cached per
commit.

The rules don't describe monsters or spells, so the bot also compiles a small
program (`native/compendium.cpp`) against the game engine. It prints the
engine's own descriptions of every monster, item, skill, spell and building,
the same text players get in their turn reports. These descriptions are
appended to the rules as a Compendium, so questions like "what does it take to
kill a Balrog?" are answered from the game's actual numbers. If a build fails, the bot falls back to the committed
`snapshot-tests/rules/<variant>.html`, if the branch has one. Without either,
it researches the code only.

The rules build runs the game repository's `Makefile`, the resulting game
binary and the compendium program on the bot's machine, so only point `GAME_REPO_URL` at a repository you
trust (or set `RULES_BUILD=false`). The LLM itself never runs anything; its
tools only read.

### Game variants

The Atlantis repo contains several game variants (`standard`, `basic`,
`fracas`, `havilah`, `kingdoms`, `neworigins`). They share the engine and the
base data in `gamedata.cpp`. Each variant sets its own game constants in
`<variant>/rules.cpp` and enables, disables or modifies items, skills and
objects in `<variant>/extra.cpp`. The bot takes this into account. It uses a
configurable default variant, and players can pick another one with the
`variant` option on `/ask` (or name it in the question). The bot finds the
variants itself: every top-level directory with a `rules.cpp`, except test
directories.

## Requirements

- Node.js 22 or newer
- `git` on the `PATH` (used to clone and update the game repository)
- `make` and a C++20 compiler (to build the player rules; set `RULES_BUILD=false`
  to skip this and use committed snapshots only)
- A Discord application with a bot token
- An OpenAI-compatible chat-completions endpoint **with tool/function-calling
  support**, for example:
  - OpenAI, or any hosted provider with an OpenAI-compatible API
  - [Ollama](https://ollama.com) (`http://localhost:11434/v1`)
  - [llama.cpp server](https://github.com/ggml-org/llama.cpp) (`--jinja` for tool calling)
  - [vLLM](https://docs.vllm.ai) or [LM Studio](https://lmstudio.ai)

Answer quality depends heavily on the model's ability to use tools and read
C++. For local setups, pick a model that is known to handle tool calling well
and has a context window of at least 32k tokens. Ollama's default context
window is much smaller, and it can't be changed through the OpenAI-compatible
API. Start the server with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`, or create a
model variant with a larger `num_ctx`.

## Setup

### 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and create a new application.
2. Under **Bot**, create a bot and copy its token.
3. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
   The bot needs it to read follow-up questions in its answer threads.
4. Under **OAuth2 → URL Generator**, select the scopes `bot` and
   `applications.commands`, and the permissions *Send Messages*,
   *Send Messages in Threads*, *Create Public Threads* and *Read Message History*.
   Open the generated URL to invite the bot to your server.

### 2. Configure

```sh
git clone https://github.com/<you>/atlantis-oracle.git
cd atlantis-oracle
npm install
cp .env.example .env
# edit .env
```

### 3. Run

```sh
npm run register-commands   # once, and whenever slash commands change
npm run dev                 # development, with auto-reload
# or
npm run build && npm start  # production
```

On first start the bot clones the game repository into `GAME_REPO_DIR`. After
that it runs `git pull` on the interval set by `GAME_REPO_SYNC_INTERVAL_MINUTES`.

The bot owns `GAME_REPO_DIR`: each sync hard-resets it to the remote and
discards local changes. Don't point it at a working copy you edit.

### Trying it without Discord

`npm run ask` runs the same research-and-answer loop in the terminal and
shows each tool call the model makes. It only needs the LLM and game repo
settings, so it's the quickest way to check that a model works well:

```sh
npm run ask -- "What does the TACTICS skill do?"
npm run ask -- --variant neworigins "How many mages can a faction have?"
npm run ask -- --no-sync "..."   # skip git fetch, use the existing clone
npm run ask -- --mode guide "..." # look the code up through the code guide
```

## Configuration

All configuration is done with environment variables, read from `.env` in development.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | | Bot token |
| `DISCORD_CLIENT_ID` | yes | | Application ID, used to register slash commands |
| `DISCORD_GUILD_ID` | no | | Register commands to one server only. They update instantly, which is useful in development. If unset, commands are registered globally. |
| `ALLOWED_CHANNEL_IDS` | no | *(all)* | Comma-separated channel IDs where the bot answers |
| `ENABLED_COMMANDS` | no | *(all)* | Comma-separated slash commands to offer: `ask`, `collective-info`, `report-bug`, `wish`, `anomalies`, `latest-release`. If unset, all are offered, except `report-bug`, `wish` and `anomalies` when `GITHUB_TOKEN` is unset, and `anomalies` when `GITHUB_POLL_INTERVAL_MINUTES` is `0`. Disabling `ask` also disables follow-ups in answer threads. Run `npm run register-commands` after changing it. |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `OPENAI_API_KEY` | yes* | | API key. *Local servers usually accept any non-empty value. |
| `LLM_MODEL` | yes | | Model name as the endpoint knows it, e.g. `gpt-4.1-mini`, `qwen3:32b` |
| `LLM_TEMPERATURE` | no | `0.2` | Sampling temperature |
| `LLM_TOP_P` | no | *(server default)* | Nucleus sampling (`top_p`); only sent when set |
| `LLM_MAX_TOOL_ITERATIONS` | no | `16` | Maximum tool-call rounds per question |
| `LLM_REQUEST_TIMEOUT_SECONDS` | no | `120` | Timeout for each LLM request |
| `LLM_MAX_RETRIES` | no | `2` | Retries per LLM request, timeouts included. Use `0` for local servers, where a timed-out request usually times out again. |
| `LLM_MAX_TOKENS` | no | `4096` | Output cap per LLM request (`max_tokens`). Stops a looping model from blocking a question; a reply cut off before any answer gets one retry. |
| `LLM_THINKING` | no | `on` | Reasoning ("thinking") for models that have it: `on` sends nothing (server default), `off` switches it off for every call, `final` switches it off while researching and on for the final answer and review (if that reasoning answer times out or is cut off, the bot asks once more without reasoning). `off`/`final` send `chat_template_kwargs.enable_thinking`, which vLLM, SGLang and oMLX understand. |
| `LLM_FINAL_MAX_TOKENS` | no | `8192` | Output cap for the reasoning calls in `LLM_THINKING=final` mode |
| `LLM_TOOL_OUTPUT_BUDGET` | no | `60000` | Total characters of tool output per question; protects the model's context window |
| `LLM_PLAN_STEP` | no | `true` | Ask the model for a research plan before it starts looking things up |
| `LLM_REVIEW_STEP` | no | `true` | Let the model check its draft answer against what it found, and research once more if something is missing |
| `LLM_LOOKUP_MODE` | no | `grep` | How the model finds its way around the code: `grep` searches with `search_code`; `guide` consults the [code guide](#code-guide) first. Falls back to `grep` when no guide file exists. |
| `LLM_MAX_CONCURRENT` | no | `1` | Questions researched at the same time; others wait in a queue. Keep at 1 for most local servers. |
| `GAME_REPO_URL` | no | `https://github.com/Atlantis-PBEM/Atlantis.git` | Game repository to answer from |
| `GAME_REPO_BRANCH` | no | *(remote default)* | Branch or tag to check out |
| `GAME_REPO_DIR` | no | `./data/game-repo` | Where the repository is cloned |
| `GAME_REPO_SYNC_INTERVAL_MINUTES` | no | `360` | How often to `git pull`. Set to `0` to disable. |
| `DEFAULT_GAME_VARIANT` | no | `standard` | Variant to assume when the player doesn't name one |
| `RULES_DIR` | no | `./data/rules` | Where the built rules and the build workspace live |
| `RULES_BUILD` | no | `true` | Build the rules with the game's `Makefile`. If `false`, only committed rules snapshots are used. |
| `CODE_GUIDE_PATH` | no | `./guides/atlantis-code.md` | The code guide used by `LLM_LOOKUP_MODE=guide` |
| `GITHUB_TOKEN` | no | | GitHub token that files `/report-bug` and `/wish` issues: a fine-grained token with *Issues: Read and write* on `GITHUB_ISSUES_REPO`. Issues are created under this token's account. Required for `/report-bug`, `/wish` and `/anomalies`. |
| `GITHUB_ISSUES_REPO` | no | `rmstdope/atlantis-hud` | The HUD repository (`owner/name`): receives bug reports and wishes, and `/latest-release` shows its releases |
| `HUD_SITE_URL` | no | `https://atlantis-hud.rmstdope.eu` | The HUD's website, linked from `/latest-release` |
| `RELEASE_ANNOUNCE_CHANNEL_ID` | no | | Channel where new HUD releases are announced, with the same message as `/latest-release`. If unset, nothing is announced. The first run announces the current release; after that, each new release is announced once. |
| `RELEASE_POLL_INTERVAL_MINUTES` | no | `15` | How often to look for a new release. `0` turns announcements off. |
| `RELEASE_STATE_PATH` | no | `./data/latest-release.json` | Remembers the last announced release across restarts |
| `GITHUB_BUG_LABELS` | no | | Comma-separated labels for `/report-bug` issues, e.g. `bug` |
| `GITHUB_WISH_LABELS` | no | | Comma-separated labels for `/wish` issues, e.g. `enhancement` |
| `GITHUB_POLL_INTERVAL_MINUTES` | no | `15` | How often reported issues are checked for updates, which are posted in a thread on the report. `0` turns tracking off. |
| `GITHUB_TRACK_CLOSED_DAYS` | no | `14` | Days a closed issue is still followed, in case it is reopened |
| `ANOMALY_STORE_PATH` | no | `./data/anomalies.json` | Where the tracked reports are kept |
| `BUG_REPORTS_PER_USER_PER_HOUR` | no | `3` | Bug reports and wishes (together) allowed per user per hour |
| `RATE_LIMIT_PER_USER_PER_MINUTE` | no | `3` | Questions allowed per user per minute |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error` |

### Suggested settings for a local Qwen3 model

A starting point for Qwen3-family models such as Qwen3.8-27B on oMLX. Qwen
recommends temperature 0.6 and top_p 0.95 for its thinking mode; near-greedy
sampling makes these models repeat themselves. The larger limits give
multi-step questions room to finish. Check the effect on your setup with
`npm run eval`.

```
LLM_THINKING=final
LLM_TEMPERATURE=0.6
LLM_TOP_P=0.95
LLM_MAX_TOOL_ITERATIONS=24
LLM_TOOL_OUTPUT_BUDGET=150000
LLM_REQUEST_TIMEOUT_SECONDS=900
LLM_MAX_RETRIES=0
```

`LLM_THINKING=final` matters most. In the evals on Qwen3.8-27B (4-bit, oMLX),
research rounds took 5-15 s each instead of minutes, and the reasoning
review still caught real calculation errors. Its reasoning calls took 1.5-3
minutes, and up to 9 minutes on the hardest question, hence the 900 s timeout.
The model's context window must hold about 80k tokens with these settings.

### Suggested settings for GLM 5.3 Flash via OpenRouter

GLM always reasons (OpenRouter rejects `reasoning: {enabled: false}` with HTTP
400), but briefly, and it keeps the reasoning out of the answer. It finds the
key facts early, so 12 rounds are enough; that halved the tokens per eval run
(to about 0.56M prompt tokens) without losing facts. Its reasoning counts
toward the output cap, so the cap must be generous.

```
LLM_MODEL=glm-5.3-flash
OPENAI_BASE_URL=https://openrouter.ai/api/v1
LLM_THINKING=on
LLM_TEMPERATURE=0.6
LLM_TOP_P=0.95
LLM_MAX_TOOL_ITERATIONS=12
LLM_MAX_TOKENS=16384
LLM_TOOL_OUTPUT_BUDGET=150000
LLM_REQUEST_TIMEOUT_SECONDS=180
LLM_MAX_RETRIES=2
```

GLM via OpenRouter sometimes writes a tool call as plain text
(`<tool_call>…<arg_key>…`) instead of calling the tool, especially in steps
where no tools are offered. The bot detects this and never sends such text to
players.

### Choosing the branch

Upstream's default branch, `master`, is no longer where development happens;
`stable` is. Set `GAME_REPO_BRANCH=stable` to answer from it. The `stable`
branch builds on macOS with Apple clang once
[Atlantis-PBEM/Atlantis#299](https://github.com/Atlantis-PBEM/Atlantis/pull/299)
is merged. Until then, use that PR's branch
(`GAME_REPO_URL=https://github.com/rmstdope/Atlantis.git`,
`GAME_REPO_BRANCH=macos-clang-build`), or run the bot on Linux.

### Using a different game repository

Set `GAME_REPO_URL` (and optionally `GAME_REPO_BRANCH`) to point at a fork or a
different Atlantis-derived codebase. The bot's tools are not tied to a
particular layout. However, the system prompt includes hints about where
things live in the upstream repo, so a fork with a very different layout may
need adjustments in `src/llm/prompts.ts`.

## Usage

| Command | Description |
|---|---|
| `/ask question:<text> [variant:<name>]` | Ask a question. The answer is posted in a new thread, and a status message shows the research steps while you wait. Used inside a thread, the bot answers in that thread. |
| Message in an answer thread | Ask a follow-up. The bot uses the thread's recent conversation as context. |
| `/report-bug description:<text>` | File a bug report as a public GitHub issue (only when `GITHUB_TOKEN` is set). The channel sees who reported it, the first line and the issue link; errors are only shown to you. Updates on the issue (comments from the repository's team, labels, assignees, linked pull requests, closing and reopening) are posted in a thread on the report; comments from anyone else are only counted. The first line becomes the title; the issue also records your Discord username and, when used in an answer thread, a link to it. Re-run `npm run register-commands` after setting the token. |
| `/wish description:<text>` | Wish for a feature or change. Works like `/report-bug`, but the issue is titled `[Wish] …` and gets the `GITHUB_WISH_LABELS`. |
| `/anomalies` | List your bug reports and wishes that are being followed, with their status and labels (only visible to you) |
| `/latest-release` | Show the HUD's latest release from GitHub: version, date, links to the release and the HUD's website, and the release notes. Only visible to you. Works without `GITHUB_TOKEN` (the repository is public). |
| `/collective-info` | Show the repository, commit, variants and model currently in use (only visible to you) |

The answers are generated by an LLM and **can be wrong**. The source references
in each answer let you check the claim yourself. When in doubt, your GM's
ruling and the published rules for your game take precedence.

## Development

```sh
npm run dev        # run with auto-reload
npm run ask -- "…" # ask a question from the terminal
npm run eval       # answer-quality evals against the configured LLM (slow)
npm run guide:check # report code guide entries that no longer resolve
npm test           # unit tests (vitest)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

`npm run eval` asks the questions in `evals/questions.json` and checks each
answer for the facts it must contain. It records time and tool use, saves a
report under `data/evals/`, and compares it with the previous run. Use it to
compare models, prompts and settings. `--only <id>` and `--tier hard` run a
subset; `--mode grep|guide` overrides `LLM_LOOKUP_MODE`, and the report
records the mode so two runs can be compared.

See [CLAUDE.md](CLAUDE.md) for architecture, conventions and design decisions.

## License

[Apache License 2.0](LICENSE). The Atlantis game code that the bot reads has
its own license (GPL); this project only reads it at runtime and does not
distribute it.
