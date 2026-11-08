# Contributing

Use synthetic resources, journeys, hierarchy dumps and test data only. Do not commit screenshots, private app code, credentials or production data.

Node.js 24 or newer is required. Clone `android-kit` and `emu-lab` alongside this repository, install their dependencies and build `@budaknyenyel/kit-schema` and `@budaknyenyel/emu-lab` before installing this package. Run `npm ci`, then `npm run build`, `npm test`, and `npm run lint` before submitting changes. Device tests require a local Android SDK, a device or emulator, and a compatible Maestro installation; do not commit their artifacts.

For a release, publish the matching sibling package versions first, build this package, and run `node scripts/prepare-publish.mjs`. Publish the temporary directory it prints and remove it afterward. The release workflow uses npm trusted publishing and requires a `v`-prefixed tag matching the package version.

Keep CLI and MCP operations equivalent. Add tests for changed behavior, preserve stable lint rule IDs, and document rule changes in the changelog. Discuss incompatible changes in an issue before submitting a pull request.
