# pi-debug Profile Roadmap

`pi-debug` should grow as a scenario-aware debugging orchestrator. The command stays simple:

```text
/debug
```

The mode selected after that should depend on the project and the user's problem.

## Core Flow

```text
/debug
  -> detect project/profile
  -> user describes the bug
  -> AI clarifies the problem
  -> user confirms the problem
  -> optionally capture reproduction logs
  -> AI creates a profile-specific test plan
  -> user confirms the test plan
  -> worker repairs and verifies
  -> user confirms the result when automated evidence is not enough
```

The important rule is that AI should not start repairing code until the problem statement is confirmed.

## Profile Model

Each profile should define:

- Detection signals
- Collector strategy
- Test planning strategy
- Verification strategy
- Known limitations

The current extension has a lightweight built-in detector. As the profile library grows, complex detection should move into `debug-detect-profile`.

## Initial Profiles

### Browser Extension

Detection:

- `manifest.json`
- `background.service_worker`, popup, options, or content scripts

Collector:

- Browser console injection for popup/options pages
- DevTools target capture for background/service worker
- Later: Chrome DevTools Protocol target discovery

Verification:

- Extension build/check
- Popup/options page smoke test
- Background/service worker log check
- User confirmation for visual behavior

### Web App

Detection:

- Vite, Next, React, Vue, Svelte, Angular dependencies
- `dev`, `preview`, or `start` scripts

Collector:

- Browser console/error/fetch/XHR injection
- Later: Playwright/CDP console and network listeners

Verification:

- Existing check/lint/test scripts
- Browser smoke test
- Playwright interaction for reproducible UI bugs

### CLI

Detection:

- `package.json` `bin`
- executable scripts
- command fixtures

Collector:

- stdout/stderr/exit code capture
- environment and argv capture

Verification:

- focused command replay
- exit code and output assertions
- existing check script

### API

Detection:

- Express, Fastify, Hono, Koa, Nest dependencies
- server/router files

Collector:

- request/response capture
- server stdout/stderr
- HTTP client reproduction

Verification:

- curl/http client checks
- status/body assertions
- existing check script

### Electron

Detection:

- Electron dependency
- main/preload/renderer files

Collector:

- main process logs
- renderer console logs
- preload errors

Verification:

- app launch smoke test
- renderer interaction test
- main/preload error absence

## Skill Layout

```text
debug-detect-profile
debug-intake
debug-test-plan
debug-worker
debug-verify
debug-profile-browser-extension
debug-profile-web-app
debug-profile-cli
debug-profile-api
debug-profile-electron
```

The generic skills remain the orchestration contract. Profile skills can be added incrementally when a scenario becomes important in real work.

---

## android-app / Android App

### Definition

Native Android apps (Kotlin/Java), React Native, Flutter, or any project that runs on Android and can be debugged via ADB.

### Detection

- `gradlew` or `gradlew.bat` exists at project root
- `build.gradle` / `build.gradle.kts` contains `com.android.application` or `com.android.library`
- `app/src/main/AndroidManifest.xml` exists
- `android/` directory exists (React Native / Flutter)
- `local.properties` contains `sdk.dir`

### Diagnostic Checklist

1. ADB connection: `adb devices` shows connected device
2. App installed: `adb shell pm list packages | grep <package>`
3. App running: `adb shell dumpsys activity top | grep ACTIVITY`
4. SDK version: `adb shell getprop ro.build.version.sdk`
5. Build system: `./gradlew --version` or project-specific build tool
6. Logcat baseline: `adb logcat -d -t 50` to capture current state

### Reproduction Strategy

**ADB Screenshot + Logcat Capture:**

```
1. adb exec-out screencap -p > .debug/pi-debug/captures/before.png
2. adb logcat -c && adb logcat -d > .debug/pi-debug/captures/logcat-before.txt
3. Navigate to bug location via adb shell input commands
4. adb exec-out screencap -p > .debug/pi-debug/captures/repro.png
5. adb logcat -d > .debug/pi-debug/captures/logcat-repro.txt
6. adb shell dumpsys activity top > .debug/pi-debug/captures/activity.txt
7. adb shell uiautomator dump > .debug/pi-debug/captures/ui.xml (optional)
```

**AI Visual Analysis:**

- Read screenshot files to identify UI anomalies (layout issues, missing elements, incorrect rendering)
- Cross-reference with logcat for error messages and stack traces
- Check UI hierarchy XML for structural problems

**Common Reproduction Patterns:**

- Layout bug: screenshot → compare with expected design
- Crash: logcat → filter for FATAL EXCEPTION or AndroidRuntime
- ANR: `adb shell dumpsys anr` → check main thread block
- Memory leak: `adb shell dumpsys meminfo <package>` → compare over time

### Verification Protocol

1. **Fix code** in the project
2. **Rebuild**: `./gradlew assembleDebug` (or `flutter build apk`, `npx react-native run-android`)
3. **Reinstall**: `adb install -r app/build/outputs/apk/debug/app-debug.apk`
4. **Restart**: `adb shell am start -n <package>/<main-activity>`
5. **Screenshot**: `adb exec-out screencap -p > .debug/pi-debug/captures/after.png`
6. **Compare**: visual diff between before and after screenshots
7. **Logcat check**: `adb logcat -d | grep -iE "error|exception|crash"` — should be clean

### Special Considerations

- **Multi-process apps**: check logcat with `--pid` filter for specific process
- **Permissions**: some ADB commands need root (`adb root`) or specific permissions
- **Device state**: ensure consistent test state (same network, logged-in user, test data)
- **Build variants**: `assembleDebug` vs `assembleRelease` — debug builds allow direct install
- **Gradle daemon**: if build hangs, `./gradlew --stop` then retry

---

## Collector Roadmap

Current:

- Local HTTP collector
- Browser console snippet
- JSONL event file under `.debug/pi-debug/captures/`

Next:

- Command collector for CLI/API stdout and stderr
- Playwright collector for web apps
- Chrome DevTools Protocol collector for browser extensions
- Electron collector for main/preload/renderer processes
- ADB collector for Android app screenshots, logcat, and UI dump

## Growth Rule

Add a new profile only when a real debugging session exposes a repeated pattern. Each profile should be grounded in actual project behavior, not theoretical coverage.
