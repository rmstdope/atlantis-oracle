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

The bot searches the configured Atlantis repository, reads the relevant code and
rules text, and writes a player-friendly answer with references to the files it
used.

> **Status:** early development. See [CLAUDE.md](CLAUDE.md) for the planned
> architecture and project conventions.

## How it works

```
Discord user ──/ask──▶ Bot ──▶ LLM (OpenAI-compatible API)
                                 │   ▲
                     tool calls  │   │ tool results
                                 ▼   │
                         Repo tools (search / read / list)
                                 │
                                 ▼
                    Local clone of the Atlantis repo
```

1. A player asks a question with `/ask` or by mentioning the bot.
2. The bot sends the question to an LLM along with a set of **tools** that let
   it search and read the local clone of the game repository.
3. The LLM decides what to look up: grepping for an item or skill name, reading
   `gamedata.cpp` tables, checking a game variant's `rules.cpp`, reading the
   generated rules HTML, and so on. It keeps going until it has enough to answer.
4. The bot posts the answer, with source references, in a thread.

The retrieval is *agentic* (the model calls tools) rather than based on
embeddings. The Atlantis game data mostly lives in large C++ tables where exact
names matter, and plain text search is precise for that. This approach also
works with any OpenAI-compatible server, including ones that don't serve an
embeddings model.

### Game variants

The Atlantis repo contains several game variants (`standard`, `basic`,
`fracas`, `havilah`, `kingdoms`, `neworigins`). They share the engine and the
base data in `gamedata.cpp`. Each variant sets its own game constants in
`<variant>/rules.cpp` and enables, disables or modifies items, skills and
objects in `<variant>/extra.cpp`. The bot takes this into account. It uses a configurable
default variant, and players can name another one in the question or with the
`variant` option on `/ask`.

## Requirements

- Node.js 22 or newer
- `git` on the `PATH` (used to clone and update the game repository)
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on the `PATH` (used for code search)
- A Discord application with a bot token
- An OpenAI-compatible chat-completions endpoint **with tool/function-calling
  support**, for example:
  - OpenAI, or any hosted provider with an OpenAI-compatible API
  - [Ollama](https://ollama.com) (`http://localhost:11434/v1`)
  - [llama.cpp server](https://github.com/ggml-org/llama.cpp) (`--jinja` for tool calling)
  - [vLLM](https://docs.vllm.ai) or [LM Studio](https://lmstudio.ai)

Answer quality depends heavily on the model's ability to use tools and read
C++. For local setups, pick a model that is known to handle tool calling well
and has a context window of at least 32k tokens.

## Setup

### 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and create a new application.
2. Under **Bot**, create a bot and copy its token.
3. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**
   if you want the bot to answer @mentions. `/ask` works without it.
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

### Docker

```sh
docker build -t atlantis-oracle .
docker run --env-file .env -v atlantis-data:/data atlantis-oracle
```

If the LLM runs on the Docker host (for example Ollama), set
`OPENAI_BASE_URL=http://host.docker.internal:11434/v1`.

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
| `LLM_MAX_TOOL_ITERATIONS` | no | `12` | Maximum tool-call rounds per question |
| `LLM_REQUEST_TIMEOUT_SECONDS` | no | `120` | Timeout for each LLM request |
| `GAME_REPO_URL` | no | `https://github.com/Atlantis-PBEM/Atlantis.git` | Game repository to answer from |
| `GAME_REPO_BRANCH` | no | *(remote default)* | Branch or tag to check out |
| `GAME_REPO_DIR` | no | `./data/game-repo` | Where the repository is cloned |
| `GAME_REPO_SYNC_INTERVAL_MINUTES` | no | `360` | How often to `git pull`. Set to `0` to disable. |
| `DEFAULT_GAME_VARIANT` | no | `standard` | Variant to assume when the player doesn't name one |
| `RATE_LIMIT_PER_USER_PER_MINUTE` | no | `3` | Questions allowed per user per minute |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error` |

### Using a different game repository

Set `GAME_REPO_URL` (and optionally `GAME_REPO_BRANCH`) to point at a fork or a
different Atlantis-derived codebase. The bot's tools are not tied to a
particular layout. However, the system prompt includes hints about where
things live in the upstream repo, so a fork with a very different layout may
need adjustments in `src/llm/prompts.ts`.

## Usage

| Command | Description |
|---|---|
| `/ask question:<text> [variant:<name>]` | Ask a question. The answer is posted in a new thread. |
| `@atlantis-oracle <question>` | Same as `/ask`, via mention |
| Reply in the thread | Ask a follow-up. The bot keeps the thread's conversation as context. |
| `/oracle-info` | Show the repository, commit and model currently in use |

The answers are generated by an LLM and **can be wrong**. The source references
in each answer let you check the claim yourself. When in doubt, your GM's
ruling and the published rules for your game take precedence.

## Development

```sh
npm run dev        # run with auto-reload
npm test           # unit tests (vitest)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

See [CLAUDE.md](CLAUDE.md) for architecture, conventions and design decisions.

## License

[Apache License 2.0](LICENSE). The Atlantis game code that the bot reads has
its own license (GPL); this project only reads it at runtime and does not
distribute it.
