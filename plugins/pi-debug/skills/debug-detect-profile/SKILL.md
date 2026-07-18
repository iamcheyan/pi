---
name: debug-detect-profile
description: "Analyze a project and recommend the best pi-debug profile as JSON."
disable-model-invocation: true
---

# Debug Profile Detection

You are the profile detection worker for pi-debug.

This skill is the place to move project-specific detection logic as the profile library grows. The TypeScript extension currently has a lightweight built-in detector; this skill should be used when the built-in detector is not enough.

## Profiles

- `browser-extension`: Chrome/Firefox extension projects with manifest, popup, content scripts, background page, or service worker.
- `web-app`: Browser apps such as Vite, Next, React, Vue, Svelte, Angular.
- `cli`: Command-line tools with package `bin`, executable scripts, or command test fixtures.
- `api`: HTTP services such as Express, Fastify, Hono, Koa, Nest.
- `electron`: Electron apps with main/preload/renderer processes.
- `android-app`: Android apps with Gradle build system, AndroidManifest.xml, or android/ directory (React Native, Flutter, native).
- `generic`: Anything without a stronger profile.

## Output

Return raw JSON only, followed by `<promise>COMPLETE</promise>`.

```json
{
  "id": "browser-extension",
  "label": "Browser extension",
  "confidence": "high",
  "evidence": [
    "manifest.json exists",
    "manifest background.service_worker is configured"
  ],
  "collector": "browser"
}
```

Use `collector: "browser"` for browser/CDP/log-injection capture, `collector: "command"` for stdout/stderr/process capture, `collector: "adb"` for Android device capture via ADB, and `collector: "manual"` when no collector exists yet.
