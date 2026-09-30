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
> `/oracle-info` work. @mentions and a Docker image are planned. See
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
2. The bot sends the question to an LLM along with a set of **tools**. At
   first, the LLM only gets the rules tools, so every answer starts from the
   player rules for the game variant.
3. If the rules don't settle the question, the code tools become available.
   The LLM can then search the source, read files, and look up items, skills
   and buildings in the `gamedata.cpp` tables. It keeps going until it has
   enough to answer.
4. The bot posts the answer, with source references, in a new thread. Players
   can ask follow-up questions by replying in the thread.

The retrieval is *agentic* (the model calls tools) rather than based on
embeddings. The Atlantis game data mostly lives in large C++ tables where exact
names matter, and plain text search is precise for that. This approach also
works with any OpenAI-compatible server, including ones that don't serve an
embeddings model.

### Player rules

On startup, and whenever the game repository changes, the bot builds each
variant with the game's own `Makefile` and runs `<variant> genrules`. That
produces the same rules HTML that players get. The bot converts it to Markdown
under `RULES_DIR`. The build runs on a `git archive` export, so the clone stays
clean. The first build takes a minute or less; after that, rules are cached per
commit. If a build fails, the bot falls back to the committed
`snapshot-tests/rules/<variant>.html`, if the branch has one. Without either,
it researches the code only.

The rules build runs the game repository's `Makefile` and the resulting game
binary on the bot's machine, so only point `GAME_REPO_URL` at a repository you
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
```

## Configuration

All configuration is done with environment variables, read from `.env` in development.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | | Bot token |
| `DISCORD_CLIENT_ID` | yes | | Application ID, used to register slash commands |
| `DISCORD_GUILD_ID` | no | | Register commands to one server only. They update instantly, which is useful in development. If unset, commands are registered globally. |
| `ALLOWED_CHANNEL_IDS` | no | *(all)* | Comma-separated channel IDs where the bot answers |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `OPENAI_API_KEY` | yes* | | API key. *Local servers usually accept any non-empty value. |
| `LLM_MODEL` | yes | | Model name as the endpoint knows it, e.g. `gpt-4.1-mini`, `qwen3:32b` |
| `LLM_TEMPERATURE` | no | `0.2` | Sampling temperature |
| `LLM_MAX_TOOL_ITERATIONS` | no | `16` | Maximum tool-call rounds per question |
| `LLM_REQUEST_TIMEOUT_SECONDS` | no | `120` | Timeout for each LLM request |
| `LLM_MAX_CONCURRENT` | no | `1` | Questions researched at the same time; others wait in a queue. Keep at 1 for most local servers. |
| `GAME_REPO_URL` | no | `https://github.com/Atlantis-PBEM/Atlantis.git` | Game repository to answer from |
| `GAME_REPO_BRANCH` | no | *(remote default)* | Branch or tag to check out |
| `GAME_REPO_DIR` | no | `./data/game-repo` | Where the repository is cloned |
| `GAME_REPO_SYNC_INTERVAL_MINUTES` | no | `360` | How often to `git pull`. Set to `0` to disable. |
| `DEFAULT_GAME_VARIANT` | no | `standard` | Variant to assume when the player doesn't name one |
| `RULES_DIR` | no | `./data/rules` | Where the built rules and the build workspace live |
| `RULES_BUILD` | no | `true` | Build the rules with the game's `Makefile`. If `false`, only committed rules snapshots are used. |
| `RATE_LIMIT_PER_USER_PER_MINUTE` | no | `3` | Questions allowed per user per minute |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error` |

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
| `/oracle-info` | Show the repository, commit, variants and model currently in use (only visible to you) |

The answers are generated by an LLM and **can be wrong**. The source references
in each answer let you check the claim yourself. When in doubt, your GM's
ruling and the published rules for your game take precedence.

## Development

```sh
npm run dev        # run with auto-reload
npm run ask -- "…" # ask a question from the terminal
npm test           # unit tests (vitest)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

See [CLAUDE.md](CLAUDE.md) for architecture, conventions and design decisions.

## License

[Apache License 2.0](LICENSE). The Atlantis game code that the bot reads has
its own license (GPL); this project only reads it at runtime and does not
distribute it.
