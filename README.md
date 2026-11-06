# maestro-flow

**Turn plain-language user journeys into Maestro UI tests that don't break every time copy changes.**

Describe a journey ("add an item to the cart, check the total updates"). maestro-flow writes a [Maestro](https://maestro.mobile.dev) flow using selectors taken from your actual string resources and accessibility tree, lints it, runs it on a device, and fixes test problems until it passes, or stops and reports an app bug with evidence. It never edits expected values to make a test pass.

Part of [android-kit](https://github.com/fridaysundaymood/android-kit), a toolkit combining five tools for end-to-end Android development. Works on its own; no other kit tool required.

## Status

> **Planning stage: there is no code to install yet.** This repo holds the design in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Star or watch it to follow progress. First milestone: string-resource index and the flow linter.

## Who it's for

- Android teams (Kotlin/Compose) using Maestro, or wanting to, especially with AI agents writing the tests.
- Anyone tired of UI tests failing because a label changed.

## What it will do

- **Resource index:** reads `res/values*/strings*.xml` (including plurals and format arguments) and Compose semantics, producing a `selectors.json` of valid selectors per locale.
- **Linter (CI-ready):** flags selectors that no longer match any string, Back on root screens, bare-number assertions, missing launch waits, and coordinate taps.
- **Flow generator:** prefers content descriptions, then exact resource text, then format-derived regexes; scopes value assertions to a screen.
- **Device loop:** runs flows (via [emu-lab](https://github.com/fridaysundaymood/emu-lab) if present, plain `adb` otherwise), classifies failures as stale selector, navigation, timing, or app bug, and repairs at most three times.
- **Multiple locales:** one journey, flows for every shipped language.

## Out of scope

Replacing instrumented logic tests or visual regression testing.

## Contributing

The design is open for feedback. Open an issue to question scope, suggest a feature, or discuss an approach before sending a pull request. Use synthetic examples only: no private app code, production data, or credentials.

## License

[MIT](LICENSE)
