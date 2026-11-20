// The script prompt, shared by the studio server (agent.mjs) and the standalone browser app
// (web/lib/prompt.js is a generated copy, guarded by a test). Keep this file free of Node APIs
// so the browser can run the exact same wording.

export const SCRIPT_SYSTEM = 'You are a short-form video director. You turn an idea into a script told scene by scene, second by second, and pick the best available animation tool for each scene. Return only the JSON requested.';

export function scriptInput({ prompt, format = '9:16', styleName, style, toolWhat }) {
  return `The user's idea:
"""${prompt}"""

Format: ${format}.

The user chose ONE style for the whole video: ${styleName}, tool id "${style}". About it: ${toolWhat}
Every scene uses this style and only this style. Design every scene for what this style does well.

Write the video:
- title (short), music (lofi/ambient/upbeat/epic/none).
- scenes: one picture each, 2-6 s, contiguous from 0, total 20-45 s unless the idea asks for another length.
- visual: exactly what we see (subject, action, framing), concrete enough to animate.
- narration: what the voice says in that scene, at most 2.4 words per second of the scene ("" for a silent beat).
- onscreen: text burned into the picture ("" if none). sound: the sound moment.
- tool: always "${style}".`;
}
