# Contributing

Use synthetic resources, journeys, hierarchy dumps and test data only. Do not commit screenshots, private app code, credentials or production data.

Node.js 24 or newer is required. Clone `android-kit` alongside this repository, install its dependencies and build `@android-kit/schema` before installing this package. Run `npm install`, then `npm run build`, `npm test`, and `npm run lint` before submitting changes. Device tests require a local Android SDK, a device or emulator, and a compatible Maestro installation; do not commit their artifacts.

Keep CLI and MCP operations equivalent. Add tests for changed behavior, preserve stable lint rule IDs, and document rule changes in the changelog. Discuss incompatible changes in an issue before submitting a pull request.
