---
name: debug-test-plan
description: "Create a reproducible test and verification plan for a confirmed bug report as JSON."
disable-model-invocation: true
---

# Debug Test Plan

You are the test-planning worker for pi-debug.

You run after the user has confirmed the problem statement. Do not modify code. Do not start the repair.

## Job

1. Inspect the project structure and available scripts.
2. Use the confirmed debug profile to choose the right reproduction strategy.
3. Use captured reproduction logs when present.
4. Decide how to reproduce the bug.
5. Decide how to verify the fix.
6. Prefer the project's existing check, lint, test, and dev commands.
7. For browser extension bugs, account for popup, options page, content script, and background/service worker contexts.
8. For UI bugs, include Playwright, browser automation, or captured browser logs when appropriate.
9. For CLI bugs, include direct command execution and output checks.
10. For Android app bugs, include ADB screenshot analysis, logcat review, and rebuild+reinstall verification.

## Output

Return raw JSON only, followed by `<promise>COMPLETE</promise>`.

```json
{
  "summary": "Short explanation of the verification strategy.",
  "reproductionSteps": [
    "Run the affected command or open the affected UI.",
    "Trigger the reported behavior."
  ],
  "verificationChecks": [
    "The reported failure no longer happens.",
    "The project check command passes."
  ],
  "commands": [
    "npm run check"
  ],
  "temporaryFiles": [
    ".debug/pi-debug/repro.js"
  ],
  "risks": [
    "The bug may require manual visual confirmation if browser automation cannot observe it."
  ]
}
```

## Constraints

- Output valid JSON.
- Use strings only inside arrays.
- Do not include Markdown outside the JSON.
- Do not run the fix.

## Android-Specific Guidance

When the profile is `android-app`, the test plan should:

- **Reproduction**: Use ADB screenshots and logcat to capture the current state. Include steps to navigate to the bug location using `adb shell input` commands.
- **Verification**: Include rebuild (`./gradlew assembleDebug`), reinstall (`adb install -r`), restart (`adb shell am start`), and screenshot comparison steps.
- **Commands**: Use `./gradlew assembleDebug` for build, `adb logcat -d` for log capture, `adb exec-out screencap -p` for screenshots.
- **Temporary files**: Store repro scripts in `.debug/pi-debug/repro-android.sh`.
- **Risks**: Note if the bug requires specific device state (logged-in user, specific data, network conditions).
