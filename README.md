# Video Studio kit

Make short animated videos from a prompt, on your own computer, with Claude, Gemini, GPT or a local GGUF model.

**▶ [Watch the 1-minute demo](docs/demo.mp4)**: pick a style, write a prompt, get a script, validate, generate.

You get:
- **Video Studio**, a local web app. Pick one of 109 styles (93 have a 5-second preview), write a prompt, and the model writes a timed, scene-by-scene script. Edit it, choose music and an optional voice-over, validate, and the model builds the video.
- **Your choice of model**: Claude Code (default, no API key), Google Gemini, OpenAI GPT, any OpenAI-compatible endpoint, or a local `.gguf` file run by llama.cpp, Ollama or LM Studio.
- **50+ Claude Code skills** for video: the ten Claude animation styles (pixel art, PS2, comic, brick toy, claymation, paper cutout, retro anime, low poly, risograph, miniature diorama), tvhead stickman explainers, lemo-opuscar's 66 film styles, HyperFrames, Remotion, kinetic type, painted watercolour, cut paper, what-if stick figures, motion-studio anime and reels, cartoon cards in 3D, story-video survival HUD, Blender clay and toon, exploded product views and four science-explainer styles (flat diagram, fluorescence microscopy, 3D molecular, lab notebook).
- A free local voice (Kokoro) and generated music. **No voice API keys.**

44 of the previews retell the same story, *the discovery of fire*, so you can compare styles side by side. The others show a clip of each style's own demo film.

## Requirements

| | |
|---|---|
| **One model backend** (see below) | writes the scripts and builds the videos |
| [Claude Code](https://claude.com/claude-code), logged in with your Claude plan (Pro or Max) | the default backend; no API key |
| *or* a Gemini API key | Gemini 2.5 Flash writes, Pro builds |
| *or* an OpenAI API key (or any OpenAI-compatible endpoint) | GPT-4.1 mini writes, GPT-4.1 builds |
| *or* a local `.gguf` model + [llama.cpp](https://github.com/ggml-org/llama.cpp) / Ollama / LM Studio | free and offline |
| Node.js 20+ and git | |
| Python 3.10+ | for the local voice |
| ffmpeg on your PATH | Windows: `winget install Gyan.FFmpeg` · macOS: `brew install ffmpeg` |
| Blender 4.2+ (optional) | only for the Blender clay / toon styles. Set `BLENDER` to its path. |
| ~3 GB of free disk space | dependencies, the voice model and renders |

Tested on Windows 11. macOS and Linux should work but are untested.

## Install

```sh
git clone <this repo> video-studio-kit
cd video-studio-kit
node setup.mjs          # add --all to also fetch every optional source repo
```

Claude Code is only required if you keep the default backend; Gemini, GPT and local GGUF models work without it.

The setup script does the following:
1. Checks the requirements.
2. Clones the third-party repos it needs at pinned versions.
3. Refreshes the Remotion skills from their own repo.
4. Installs the Node dependencies and a headless browser.
5. Downloads the Kokoro voice (about 340 MB).

You can run it again safely. `npm test` runs the model-backend test suite (no API keys needed: it starts local mock servers and checks the script and build paths).

## Use

**In the app.** On Windows, double-click `Start Video Studio.cmd`. On macOS or Linux, run `sh start-studio.sh`. It opens http://localhost:4790.
1. Pick a style on the left. The viewer plays its example.
2. Write your prompt and press **Write the script**. The whole video uses the style you picked.
3. Edit the script table: times, what we see, narration, on-screen text, sound, notes.
4. Choose the voice-over (off by default) and the music.
5. Press **Validate script & generate video**. The model renders each scene and stitches them. When it finishes, the video opens in a window with **Open folder** and **Save a copy**. Finished videos are also copied to `outputs/`.

Prefer to write scripts in a page with no studio server? Open http://localhost:4790/app/ — see [Browser app](#browser-app).

**In Claude Code.** Open a terminal in this folder, run `claude`, then type `/video-studio a 30-second story about …`.

## Choose the model

Click **⚙** next to **+ New video**. The same model writes the script and runs the build (both jobs are agentic: it reads the style skill, writes scene code, renders, checks frames and stitches).

| Backend | What you need | Notes |
|---|---|---|
| **Claude Code** (default) | [Claude Code](https://claude.com/claude-code) installed and logged in with a Pro/Max plan | Nothing changes from earlier versions. Uses your plan, no API key. |
| **Google Gemini** | An API key from [AI Studio](https://aistudio.google.com/apikey) → paste it in the panel, or set `GEMINI_API_KEY` | `gemini-2.5-flash` for the script, `gemini-2.5-pro` for the build. |
| **OpenAI GPT** | An API key from [platform.openai.com](https://platform.openai.com/api-keys), or set `OPENAI_API_KEY` | `gpt-4.1-mini` writes, `gpt-4.1` builds. Put any OpenAI-compatible URL in **Base URL** for OpenRouter, Groq, Together, vLLM… |
| **Local GGUF** | A `.gguf` file, and `llama-server` on your PATH (or its full path in the panel) | Video Studio starts `llama-server` with your file and stops it with the app. Ollama and LM Studio also work: start them and use their base URL (`http://127.0.0.1:11434/v1` / `:1234/v1`). |

**Local models.** Use an *instruct* model with tool calling: Qwen2.5/Qwen3 14B or 32B, Llama 3.1 8B+, Mistral Small 3. A Q4_K_M 14B needs roughly 10 GB of RAM/VRAM. If your model does not support native tool calls, set **Tool calling → text protocol**; it still builds, but slower and with more mistakes. See [docs/models.md](docs/models.md) for install steps, model links and troubleshooting.

**Where the settings live.** `video-studio/llm.config.json` (git-ignored, private file) or environment variables (`VS_PROVIDER`, `VS_SCRIPT_MODEL`, `VS_BUILD_MODEL`, `VS_API_KEY`, `VS_BASE_URL`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `VS_GGUF_PATH`, `VS_LLAMA_SERVER`, `VS_LLAMA_PORT`, `VS_LLAMA_CTX`, `VS_GPU_LAYERS`, `VS_TOOL_MODE`, `VS_MAX_STEPS`). Environment wins. The browser never receives a saved key: the panel only shows whether one is set. **Test connection** before you rely on it.

Everything else in the kit — the 50+ skills, the `/video-studio` slash command, the Blender tooling — still uses Claude Code when you run it from a Claude Code session. The model panel changes the studio app's two buttons.

## Browser app

There is also a standalone page for writing scripts without the studio server: **<http://localhost:4790/app/>**. It is plain static files (`video-studio/web/`), so any static host can serve it.

- Pick **Gemini**, **OpenAI GPT** or a **local endpoint**, paste your key (optional for local servers), press **Test connection**, then write and edit the script scene by scene.
- Videos live in your browser (IndexedDB), with autosave, **Export**/**Import** and a project list. Nothing is uploaded anywhere except your prompt to the provider you chose.
- Keys stay in this browser — localStorage when **Remember the key** is checked, otherwise the tab's session storage — and go straight to the provider. The studio server never receives them.
- **Render with local tools** hands the project to the studio on this computer and starts the build (using the studio's own ⚙ backend). With no studio running, **Download project JSON** and the two commands shown render it locally. The page can also point at a studio URL in its settings.
- The page is served at `/app/` by the studio. If you host it elsewhere, set the studio URL and serve the page over `http://` from localhost: the studio allows loopback origins only, and an `https` page cannot call `http://127.0.0.1`.
- Gemini and OpenAI accept browser requests. Local servers may not: Ollama needs `OLLAMA_ORIGINS=*` (or this page's origin), and llama-server must allow CORS. If a provider blocks the browser, use the studio's backend instead.
- `npm run web:sync` refreshes `web/styles.json` and the scene/prompt modules copied into `web/lib/`; a test fails if they drift from the server sources.

## How it uses your subscription

With the default backend, writing a script is one short Claude Code call. Building a video runs Claude Code headless (`claude -p`) in this folder with file and shell tools: it reads the style's skill, writes the scene code, renders and checks frames. That uses your plan's usage like a long conversation does, and depends on the style and length. Nothing is billed separately, and nothing is sent anywhere except to Claude through Claude Code.

With Gemini, OpenAI or a local model, the studio runs the same job itself: it sends the prompt and the scene table to the API you chose, then executes the tools the model asks for (shell, read/write/edit files, glob, grep) inside this folder. Only that API sees your prompt. A local GGUF model sends nothing anywhere.

## Speed (Intel laptop GPU)

| Style family | 5 s of video |
|---|---|
| Fast: tvhead, HyperFrames, Remotion, kinetic, science, exploded view | about 1 to 3 min |
| Medium: painted, lemo films, motion-studio | about 3 to 10 min |
| Slow: Blender clay (Cycles) | about 30 min |

## Folders

| Folder | What's in it |
|---|---|
| `video-studio/` | the app (`vs.mjs` server, `agent.mjs` builder, `llm/` model backends, `ui/`, `web/` browser app, `catalog.json`, `tools/`, `examples/`) |
| `.claude/skills/` | the skills, including `video-studio`, the orchestrator |
| `studio/` | the tvhead engine, with the Kokoro voice patch |
| `demos/` | the working setup of each tool that the build recipes start from |
| `repos/` | third-party sources, cloned by setup (not in git) |
| `overlays/` | our additions to those sources, applied by setup |
| `outputs/` | your finished videos (not in git) |

## Credits

This kit stands on the work of these open-source projects. Thank you to their authors.

- [JohnHeibel/ClaudeAnimationBase](https://github.com/JohnHeibel/ClaudeAnimationBase): the painted watercolour engine (same as painted-animation)
- [Leonxlnx/earshot](https://github.com/Leonxlnx/earshot): earshot and real-sound: judging and building sound
- [LottieFiles/motion-design-skill](https://github.com/LottieFiles/motion-design-skill): motion-design principles
- [morgsdoti/story-video-studio](https://github.com/morgsdoti/story-video-studio): story-video-studio: stickman survival story prompt
- [Vladic20/tvhead-studio](https://github.com/Vladic20/tvhead-studio): tvhead-video (15 story looks incl. stickman), motion-studio (anime, motion reel), blender-3d, ai-montage
- [ahujasid/mcp-for-blender](https://github.com/ahujasid/mcp-for-blender): Blender MCP (Claude controls an open Blender)
- [angrypenguinpng/blender-claymation-skill](https://github.com/angrypenguinpng/blender-claymation-skill): blender-claymation: Cycles clay stop-motion
- [cth9191/animate](https://github.com/cth9191/animate): animate: one-canvas procedural pieces with a synth score
- [greensock/gsap-skills](https://github.com/greensock/gsap-skills): GSAP animation skills
- [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes): HyperFrames: HTML + GSAP to video, registry of blocks, media tools
- [kelano86/what-if-animation](https://github.com/kelano86/what-if-animation): what-if-animation stick-figure episodes
- [lemomo-ai/lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar): lemo-opuscar: 66 short-film styles
- [mromidev/claude-animated-shorts](https://github.com/mromidev/claude-animated-shorts): cartoon-3d-short: 2D cartoon cards in a 3D world
- [openai/whisper](https://github.com/openai/whisper): Whisper: word timings for captions
- [remotion-dev/skills](https://github.com/remotion-dev/skills): the Remotion skills (React video)
- [showheyohtaki/motion-prompt](https://github.com/showheyohtaki/motion-prompt): motion-prompt: library of 120 motion moves
- [tuzhechen2005/opus-video-skills](https://github.com/tuzhechen2005/opus-video-skills): kinetic-reel and painted-animation
- [zhuyansen/awesome-claude-video-skills](https://github.com/zhuyansen/awesome-claude-video-skills): index of Claude video skills (where many of these were found)
- **claude-animation-styles** kit by [@ernestosoftware](https://x.com/ernestosoftware) on X: the ten Claude animation styles (pixel art, PS2, comic, brick toy, claymation, paper cutout, retro anime, low poly, risograph, miniature diorama)

Built on: [Claude Code](https://claude.com/claude-code), [Remotion](https://www.remotion.dev), [three.js](https://threejs.org), [GSAP](https://gsap.com), [Playwright](https://playwright.dev), [FFmpeg](https://ffmpeg.org), [Blender](https://www.blender.org), the [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) voice via [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx), and [Kenney](https://kenney.nl) CC0 3D models.

## Licences

Third-party code keeps its own licence; see [THIRD_PARTY.md](THIRD_PARTY.md). Remotion's skills are included as published in [remotion-dev/skills](https://github.com/remotion-dev/skills) (that repo has no licence file); Remotion itself has its own licence: https://www.remotion.dev/docs/license
