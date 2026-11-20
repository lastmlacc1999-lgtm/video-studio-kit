# Model backends

Video Studio has two jobs that need a language model:

1. **Write the script** — one call that turns your idea plus the chosen style into a scene table.
2. **Build the video** — an agent loop that reads the style's skill, writes scene code, runs ffmpeg/Remotion/Blender, checks frames, registers clips and stitches the result.

Both use the backend you pick in the **⚙** panel (top left, next to *+ New video*). Claude Code is the default, so an existing install keeps working exactly as before.

| Provider | Script model (default) | Build model (default) | Key |
|---|---|---|---|
| Claude Code | `sonnet` | `opus` | none — your Claude plan |
| Google Gemini | `gemini-2.5-flash` | `gemini-2.5-pro` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| OpenAI GPT | `gpt-4.1-mini` | `gpt-4.1` | `OPENAI_API_KEY` |
| Local GGUF | the model in your `.gguf` | same | none |

You can use different models for the two jobs; the script is a small task, the build is a long one.

---

## Browser app (`/app/`)

`http://localhost:4790/app/` is a static page that writes scripts without involving the studio server: the calls go from your browser to Gemini, OpenAI or a local endpoint, and projects are stored in IndexedDB. It has its own model settings (kept in the browser), separate from `video-studio/llm.config.json`; the studio's ⚙ panel is still what picks the **build** model.

- **Keys** live in this browser only (localStorage if you tick *Remember*, otherwise the tab's session storage) and are sent straight to the provider. The studio API never sees them.
- **Rendering** is optional. When a studio is reachable the page sends the project (`PUT /api/project/<slug>`, then `/build`) and polls the log and final video. Without one it offers a project download and the `vs.mjs new` / `serve` commands.
- **Serving.** `/app/` is served by the studio and is the easiest setup. Any static host works for writing; then set the studio URL in the page's settings and serve the page from localhost, because the studio only allows loopback origins and an `https` page cannot call `http://127.0.0.1`.
- **Provider CORS.** Gemini and OpenAI allow browser requests. Ollama denies unknown web origins by default — start it with `OLLAMA_ORIGINS=*` (or the page's origin). llama-server needs its CORS support enabled. If a provider blocks the page, use the studio backend instead.
- **Keeping in sync.** `npm run web:sync` regenerates `web/styles.json` and copies the shared scene/prompt modules into `web/lib/`; `npm test` fails if the copies drift.

---

## Claude Code (default)

Nothing to configure. The studio runs `claude -p` exactly as earlier versions did. Install it from <https://claude.com/claude-code> and run `claude` once to log in.

The `/video-studio` slash command and every skill in `.claude/skills/` still use Claude Code, whichever backend the app is set to.

---

## Google Gemini

1. Create an API key at <https://aistudio.google.com/apikey>.
2. In the studio: **⚙ → Provider → Google Gemini**, paste the key, keep (or change) the model names, **Save**, then **Test connection**.
   Or set `GEMINI_API_KEY` in your environment; the environment wins over the saved file.
3. `gemini-2.5-flash` writes a script in a few seconds. `gemini-2.5-pro` is noticeably better at the long build loop, and more expensive.

The studio calls `POST /v1beta/models/<model>:generateContent`, sends tools as `functionDeclarations` and the script schema as a `responseSchema` (JSON Schema adapted to Google's OpenAPI subset).

**If you see `429` or quota errors**: the build loop makes many calls. Gemini's free tier is small (5 requests/minute on the Flash models, 15 on Flash-Lite, and a daily cap), so the client paces requests automatically: 12.5 s between calls for Flash, 4.5 s for Flash-Lite. Paid keys can set `VS_GEMINI_MIN_INTERVAL_MS=0` to remove the wait. If the daily cap is exhausted, wait for the midnight Pacific reset or build with Claude Code, OpenAI, or a local model.

---

## OpenAI GPT (and OpenAI-compatible APIs)

1. Create a key at <https://platform.openai.com/api-keys>.
2. **⚙ → Provider → OpenAI GPT**, paste the key. `gpt-4.1-mini` writes, `gpt-4.1` builds. Save, test.

**Other OpenAI-compatible services** work too: choose *OpenAI GPT* and set **Base URL** to their `/v1` endpoint. Examples:

| Service | Base URL |
|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| vLLM / TGI (your GPU server) | `http://<host>:8000/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| Ollama | `http://127.0.0.1:11434/v1` |

For a self-hosted server, use the *Local GGUF* provider instead so the studio knows the server is local and gives better errors.

---

## Local GGUF files

GGUF is the file format used by llama.cpp. Video Studio can start `llama-server` for you, or talk to a server you already run.

### 1. Install llama.cpp

You need the `llama-server` binary (part of llama.cpp).

- **Windows**: download the latest release zip from <https://github.com/ggml-org/llama.cpp/releases> (e.g. `llama-b####-bin-win-cuda-x64.zip` for NVIDIA, `...-vulkan-x64.zip` for AMD/Intel, or the plain CPU build), unzip it somewhere permanent, and either add that folder to `PATH` or put the full path to `llama-server.exe` in the panel. `winget install llama.cpp` also works on recent Windows builds.
- **macOS**: `brew install llama.cpp`
- **Linux**: use the release binaries, or build with `cmake -B build && cmake --build build -j`. Some distros package it as `llama.cpp`.

Check it with `llama-server --version`.

### 2. Get a model

Download a single `.gguf` file from Hugging Face. Prefer an **instruct** model with tool-calling support:

| Model | Size | RAM/VRAM (Q4_K_M) | Notes |
|---|---|---|---|
| `Qwen2.5-14B-Instruct` (Q4_K_M) | ~9 GB | ~10–12 GB | best balance for the build loop |
| `Qwen2.5-32B-Instruct` (Q4_K_M) | ~20 GB | ~22–24 GB | strongest local option; slow on CPU |
| `Qwen2.5-7B-Instruct` (Q4_K_M) | ~4.7 GB | ~6 GB | good for scripts, weaker at long builds |
| `Llama-3.1-8B-Instruct` (Q4_K_M) | ~4.9 GB | ~6–7 GB | decent tool calls |
| `Mistral-Small-3.x` (Q4_K_M) | ~14 GB | ~16 GB | strong multilingual |

Search Hugging Face for `<model> GGUF` (bartowski and unsloth publish single-file Q4_K_M quants). Q4_K_M is the usual quality/size sweet spot. Put the file anywhere, e.g. `D:\models\qwen2.5-14b-instruct-q4_k_m.gguf`; `.gguf` files are git-ignored.

### 3. Point the studio at it

**⚙ → Provider → Local GGUF**:

| Field | Example | Meaning |
|---|---|---|
| GGUF file | `D:\models\qwen2.5-14b-instruct-q4_k_m.gguf` | the model to serve |
| Runtime | `auto` | `auto` uses llama.cpp for a GGUF file |
| llama-server binary | `llama-server` | on `PATH`, or a full path |
| Port | `8080` | where the server listens (127.0.0.1 only) |
| Context size | `16384` | 16k is enough for the scene table + skill text; raise it if your model supports it |
| GPU layers | `auto` | `auto` = `-ngl 999` (all layers on GPU). Use `0` for CPU, or a number if the model does not fit |
| Tool calling | `auto` | native function calls; switch to *text protocol* if the model has no tool template |

**Save**, then **Test connection**. The first request loads the model (10–60 s depending on size and disk). The studio runs:

```
llama-server -m <your.gguf> --host 127.0.0.1 --port 8080 -c 16384 -ngl 999 --jinja
```

`--jinja` makes llama.cpp use the model's own chat template, which is what enables tool calling. Add extra flags with `VS_LLAMA_ARGS` if you need them (e.g. `VS_LLAMA_ARGS="--flash-attn"`).

The server keeps running between scripts and builds, and is stopped when the studio process exits.

### Already running a server? (Ollama, LM Studio, llama-server)

Leave **GGUF file** empty and set **Base URL** to the server's `/v1` endpoint. Then either start the server yourself or use **Runtime** to pick `ollama` / `lmstudio` (that only changes the default URL and the error messages).

- **Ollama**: `ollama serve`, then `ollama pull qwen2.5:14b`. Base URL `http://127.0.0.1:11434/v1`, model `qwen2.5:14b`.
  To run your own `.gguf` in Ollama, create a `Modelfile` with `FROM D:\models\your.gguf`, then `ollama create mymodel -f Modelfile`.
- **LM Studio**: Developer tab → Start Server, load the GGUF, base URL `http://127.0.0.1:1234/v1`, model = the id LM Studio shows.
- **Existing llama-server**: base URL `http://127.0.0.1:<port>/v1`.

Use **Load models** in the panel to ask the server which model ids it accepts, and put that id in the model fields (needed for Ollama/LM Studio; llama.cpp accepts its own id).

### Tool calling and weak models

The build loop sends six tools: `bash`, `read_file`, `write_file`, `edit_file`, `list_files`, `grep`. A model needs to emit valid tool calls for that.

- **`auto`** (default) tries native function calls. If the server rejects them, it falls back to the text protocol automatically.
- **`text protocol`** asks the model to write a fenced block:

  ````text
  ```tool
  {"name": "bash", "arguments": {"command": "ffmpeg -version"}}
  ```
  ````

  It is more forgiving but slower; use it for models whose chat template has no tool support.
- **`native`** forces function calls.

Small models (7–8B) can write a good script and handle simple builds, but they may loop, skip the frame check or invent commands. If a build stalls, raise **Max steps** or use a bigger model. A 14B Qwen with native tools is the smallest setup that reliably gets through the longer styles.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `llama-server was not found` | Install llama.cpp and put it on `PATH`, or give the full path to the binary (`.exe` on Windows). |
| `no local model server at …` | Nothing is listening: set the GGUF file (studio starts the server), or start Ollama / LM Studio and check the base URL/port. |
| `GGUF file not found` / `looks empty` | Check the path; partial downloads are common. Use the full download, not a `.part` file. |
| `llama-server stopped while loading` | Usually too little RAM/VRAM. Lower **GPU layers** to a number that fits, use a smaller quant (Q3_K_M/Q4_K_M), or a smaller model. |
| Loads forever | Big models on CPU are slow. Raise `VS_LLAMA_LOAD_TIMEOUT` (seconds) or lower the context size. |
| `HTTP 400` mentioning tools | The model/template has no tool support: set **Tool calling → text protocol**. |
| Build ends with *max steps* | Raise **Max steps** in the panel, or use a model with better tool use. |
| Out-of-memory mid-build | Video rendering + a 32B model can exceed RAM. Use a smaller model while rendering, or free memory before pressing Build. |
| GPU not used | `-ngl 999` needs a CUDA/Metal/Vulkan build of llama.cpp. Check `llama-server` startup logs in the studio's Progress panel. |
| Corporate proxy | Node's built-in fetch ignores `HTTP(S)_PROXY`. The studio borrows undici (installed with `studio/`) and honours the proxy for cloud calls while keeping localhost direct. If the proxy is still not used, run the studio with `NODE_USE_ENV_PROXY=1` (newer Node) or use a local model. |

Local models are slower to think than hosted ones, and the video renderers are the real bottleneck anyway. A 14B model on a modern GPU adds about 5–20 s per tool step.

---

## Settings reference

Saved in `video-studio/llm.config.json` (git-ignored, mode 600). Environment variables override it.

| Config key | Environment | Meaning |
|---|---|---|
| `provider` | `VS_PROVIDER` | `claude`, `gemini`, `openai`, `local` (aliases: `gguf`, `ollama`, `lmstudio`, `gpt`, `google`…) |
| `scriptModel` | `VS_SCRIPT_MODEL` | model for the script |
| `buildModel` | `VS_BUILD_MODEL` | model for the build |
| `apiKey` | `VS_API_KEY`, or `GEMINI_API_KEY` / `OPENAI_API_KEY` | secret; never sent to the browser |
| `baseUrl` | `VS_BASE_URL` | API endpoint, or the local server's `/v1` URL |
| `ggufPath` | `VS_GGUF_PATH`, `GGUF_PATH` | `.gguf` file to serve |
| `llamaServer` | `VS_LLAMA_SERVER`, `LLAMA_SERVER` | llama-server binary |
| `localRuntime` | `VS_LOCAL_RUNTIME` | `auto`, `llama.cpp`, `ollama`, `lmstudio`, `server` |
| `localPort` | `VS_LLAMA_PORT` | llama-server port (default 8080) |
| `ctxSize` | `VS_LLAMA_CTX` | context window (default 16384) |
| `gpuLayers` | `VS_GPU_LAYERS` | `auto` or a number |
| `toolMode` | `VS_TOOL_MODE` | `auto`, `native`, `text` |
| `maxSteps` | `VS_MAX_STEPS` | maximum tool rounds per build (default 160) |
| `temperature` | `VS_TEMPERATURE` | default 0.6 |
| `timeoutMs` | `VS_LLM_TIMEOUT` | per-request timeout (default 15 min) |
| — | `VS_GEMINI_MIN_INTERVAL_MS` | milliseconds between Gemini requests; `0` disables pacing. Default: 12500 for Flash, 4500 for Flash-Lite |
| — | `VS_LLAMA_LOAD_TIMEOUT` | seconds to wait for a GGUF model to load (default 240) |
| — | `VS_LLAMA_ARGS` | extra flags appended to the llama-server command |
| — | `VS_CONFIG` | use a different config file (handy for testing) |
| — | `VS_HOST`, `VS_PORT` | server bind address/port (default `127.0.0.1:4790`) |

Example: your own `.gguf`, everything else defaults:

```sh
export VS_PROVIDER=local
export VS_GGUF_PATH=/models/qwen2.5-14b-instruct-q4_k_m.gguf
npm run studio
```

(or on Windows PowerShell: `$env:VS_PROVIDER="local"; $env:VS_GGUF_PATH="D:\models\..."`)

### Security

- The config file contains your API key when you save one. It is git-ignored and written with owner-only permissions.
- The settings API never returns the key; it only reports whether one is set and whether it came from an environment variable.
- The server binds to `127.0.0.1` by default. Do not expose it to your network with `VS_HOST=0.0.0.0` unless you understand that anyone who can reach it can change your model settings.
- Build tools are jailed to this repository and the project folder; the model cannot write outside them through the tools.
- The **browser app** stores its keys in this browser (localStorage, or sessionStorage when *Remember* is off) and sends them only to the provider — never to the studio server. Because the studio accepts API calls from any loopback origin (so the browser app works when served by another local static server), avoid running other localhost pages you do not trust. The browser app itself is static: it has no server-side code and no access to your filesystem.

---

## How the build works with a non-Claude model

1. `vs.mjs` receives **Validate script & generate video** and calls `buildProject(slug)`.
2. `agent.mjs` resolves the backend and creates a client (`llm/index.mjs`).
3. For a local model it starts `llama-server` if needed and waits for `/v1/models`.
4. `runToolLoop` sends the build task plus the six tool definitions. The task already contains the validated scene table and the catalog facts for the chosen styles, so the model does not have to read the 32 KB `catalog.json` first. The model replies with tool calls; the studio executes them, trims the output, and sends it back. Repeat until the project is marked done or `maxSteps` is reached. If a model stops early, the studio nudges it to continue; long local builds are trimmed turn-by-turn to stay inside the context window.
5. Clips, progress and the final video are recorded through the same `vs.mjs progress` / `vs.mjs done` commands Claude Code uses, so the UI works identically.
6. Log lines show the provider name and each tool call; failures include the provider's error and a hint.

The full build prompt and rules live in `agent.mjs` and `.claude/skills/video-studio/SKILL.md`, which every backend reads.
