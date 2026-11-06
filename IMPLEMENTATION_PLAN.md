# Journey-to-Maestro skill: implementation plan

## Status

M1–M4 functionality is implemented. Unit tests and the fixture's offline stale-selector check pass; real-device EN/ID verification remains pending a buildable fixture APK.

## Problem and goal

Hand-authored UI journeys can break when copy or navigation conventions change. Selectors recalled from memory and assertions that match unrelated values make failures hard to diagnose. Build an agent skill and helper CLI that turn a written journey into a Maestro flow grounded in Android string resources and the accessibility tree, then iterate on a device until it passes or an app bug is supported by evidence. The CLI also supports the complete workflow without an agent or MCP.

Non-goals: replacing instrumented logic tests or visual regression testing.

## Inputs and outputs

- Input: a plain-language journey or a table of steps and expectations, app package, target locale, and optional currency or state preconditions.
- Output: `e2e/maestro/NN-<slug>.yaml`, including a short intent header, and a run report with either a pass or an evidence-backed failure classification.
- Store run evidence and artifacts under `.android-kit/runs/<run-id>/maestro-flow/`. Treat hierarchy dumps and screenshots as potentially sensitive; keep them local unless explicitly shared.

## Architecture and interfaces

Implement the core as a TypeScript library on Node.js LTS, distributed as an npm package; Bun is optional. A CLI exposes every operation, and a thin MCP adapter exposes the same capabilities over stdio using tools only, without client-specific features. Optional MCP features such as progress or elicitation must degrade gracefully. The kit may compose the library in-process.

Every CLI command supports `--json` and emits the `kit-schema` v1 JSON Schema envelope: `{ schema_version: "1", tool, operation, run_id, status: pass|fail|flaky|blocked|unsupported|error, classification?: app|test|environment|config, summary, evidence[], artifacts[], started_at, duration_ms }`. `fail` means the thing under test failed; `error` means the tool itself failed; `blocked` means a precondition or policy refused execution; `unsupported` means a capability is unavailable and is never silently skipped. Exit codes are 0 for pass, 1 for fail or flaky, and 2 for error, blocked, or unsupported.

| CLI | MCP tool | Purpose |
| --- | --- | --- |
| `maestro-flow index` | `maestro_flow_index` | Build the resource and semantics index. |
| `maestro-flow lint` | `maestro_flow_lint` | Check flows against the index and lint rules. |
| `maestro-flow generate` | `maestro_flow_generate` | Generate flows from structured journey steps and expectations. |
| `maestro-flow run` | `maestro_flow_run` | Run a flow or suite and report evidence and classification. |
| `maestro-flow doctor` | `maestro_flow_doctor` | Report prerequisites, compatibility, and fixes. |

`generate` accepts a journey table as input; translating free-form prose into that table is an agent or human authoring step, not a requirement for the CLI to invoke a model. The CLI exposes the same inputs, evidence, and controls as each MCP tool; no agent is needed to prepare a table, edit a flow or conventions, and run the iteration loop.

## Components

### Resource index

- Parse `res/values*/strings*.xml`, including plurals and arrays, into a key-to-locale index. For selector regexes, escape all regex metacharacters in literal text before substituting format arguments with bounded wildcards; handle positional and repeated arguments, escaped percent signs, and each plural quantity separately. Preserve surrounding literals and report unsupported format constructs rather than emit an unsafe selector.
- Inspect Compose source for literal `contentDescription` and `semantics` values and `stringResource(R.string.x)` usage, mapping resource keys to screens where possible.
- Generate `selectors.json` for authoring and linting; it is gitignored and reproducible from the same inputs and tool version, with deterministic ordering and no timestamps. Account for semantics merging by consulting a real merged accessibility hierarchy, not source alone; record hierarchy inputs when used so the index can be reproduced.

### App conventions

Maintain an app-specific `e2e/maestro/CONVENTIONS.md`, seeded from observed hierarchies and failures. Examples include waiting for a stable launch anchor, using tabs rather than Back on root screens, tapping the action exposed by a swipe-to-delete, hiding the keyboard before selecting obscured controls, and scrolling to off-screen settings. The skill reads the file before authoring and records newly observed conventions after fixes; these examples are not universal assumptions.

### Flow generator

- Generate a launch with cleared state and retry, a stable anchor wait, necessary locale/currency or other state preconditions, journey steps, and assertions.
- Prefer content descriptions, then resource-backed exact text, then regexes derived from format strings. Use coordinates only when an element has no semantics, and flag the accessibility finding.
- Scope numeric assertions to a screen container or use a complete label rather than a bare number; assert the new value is present and the old value absent.
- Target Maestro CLI `>=1.39.0 <2.0.0` and the flow YAML command schema supported by the detected CLI version. Pin the exact version used in CI; doctor rejects versions outside the range and generation or linting reports unsupported commands instead of producing incompatible YAML. Expand the range only after compatibility tests pass.

### Linter

- Resolve literal selectors against current string resources or content descriptions and report stale selectors before a device run. Incorporate merged hierarchy evidence where source semantics alone are insufficient, and distinguish unknown selectors from confirmed stale ones.
- Flag Back on root screens, bare numeric assertions, missing launch anchor waits, and coordinate taps.
- Give each rule a stable ID and document its severity, rationale, and version. Version rule-set changes under semver; retain IDs across releases and document retired IDs and breaking behavior in the changelog. Support explicit, scoped suppressions by rule ID with a required reason; reject unknown IDs and report unused suppressions.
- Run in CI so copy changes surface before device execution. Diagnostics identify the flow, location, selector, and rule ID.

### Device iteration

Use emu-lab optionally when available; otherwise use the supplied adb device serial with `maestro test` directly. No emu-lab configuration or MCP client is required. Inspect the failure hierarchy and classify: stale selector (expected screen, changed copy), navigation (wrong screen), timing (passes on rerun), or app bug (correct screen but wrong value, or crash). Repair the flow or add a wait only where supported by evidence; stop and report an app bug with evidence. Never change expected values to hide a bug or edit app code. Limit automatic fixes to three iterations per flow, then stop and report the unresolved result.

## Skill workflow

Ship plain Markdown skill files in `SKILL.md` frontmatter format and an `AGENTS.md` snippet, readable by any agent; neither requires a particular agent product. Each step names its CLI operation and MCP equivalent:

1. Read conventions and refresh the index with `maestro-flow index` or `maestro_flow_index`.
2. Express the journey as a step-to-expected-UI table, then generate with `maestro-flow generate` or `maestro_flow_generate`.
3. Check with `maestro-flow lint` or `maestro_flow_lint` and fix evidenced lint findings.
4. Run the flow alone on a clean device with `maestro-flow run` or `maestro_flow_run`, applying the classification and iteration limits above.
5. Run the full suite once with `maestro-flow run` or `maestro_flow_run` to detect inter-flow state leaks.
6. Record learned conventions and report evidence from `maestro-flow run` or `maestro_flow_run`. Never edit expected values to make a test pass.

A human can follow the same steps and edit the table, flow, and conventions directly; neither CLI nor MCP performs autonomous edits outside the requested operation.

## Configuration

Validate the optional `maestroFlow` section of `android-kit.yaml` against a published JSON Schema, rejecting unknown keys. Configure paths, supported Maestro version, lint suppressions, and device selection there; no other tool's section is required. Explicit CLI options override this section. Defaults permit standalone use without a kit configuration file.

## Production readiness

- Support Windows, macOS, and Linux. Resolve executable paths and quoting without shell-specific assumptions; on Windows support the Maestro and Android SDK launchers and document Java and emulator setup. Device and emulator availability varies by host and CI runner.
- Declare supported versions of Node.js, Java, Maestro CLI, adb, and the Android emulator; pin exact external tool versions in CI. `maestro-flow doctor` reports missing or incompatible prerequisites and actionable fixes, including the Maestro range and flow schema compatibility. Device-only prerequisites are not required for offline indexing or linting.
- Use semver and maintain a CHANGELOG. Plan `SECURITY.md` and `CONTRIBUTING.md` in M1. No telemetry.
- Run unit tests on Windows, macOS, and Linux in CI; run integration tests on each OS where device infrastructure permits, with compatibility fixtures for supported Maestro versions.
- Emit structured logs separately from JSON stdout, with secrets and sensitive hierarchy content excluded. Record tool versions and input references with run artifacts.
- Handle crashes and interrupts by terminating child processes, marking incomplete runs, and preserving evidence; use run-scoped temporary files and atomic writes so reruns are idempotent and do not overwrite unrelated flows. Clearly report any device state that could not be restored.

## Milestones

1. **M1 — Index and linter:** implement the library, CLI and MCP adapters, schema/config validation, doctor, deterministic index and versioned lint rules; exercise synthetic fixtures including stale copy and format/plural edge cases. Add contribution and security guidance and cross-platform CI.
2. **M2 — Generator and conventions:** generate version-compatible flows from synthetic journey tables and compare them with expected hand-authored YAML; ship the agent-neutral skill and snippet.
3. **M3 — Device iteration:** exercise serial selection, optional emu-lab integration, interruption recovery, classification and appropriate repairs using synthetic stale-selector, navigation, timing, and app-bug scenarios.
4. **M4 — Locales and CI:** generate flows for multiple locales from one journey, test supported Maestro versions and add a CI lint hook.

## Testing and risks

Use a synthetic fixture app and schema with known resources, semantics, navigation, and journey expectations. Mutate a fixture string and assert that dependent flows are flagged; use fixture journeys and expected YAML as golden cases. Test regex escaping, positional and plural formats, reproducible indexes, suppressions, and unsupported formats and CLI versions. Test merged semantics against an actual hierarchy dump. Prevent over-eager fixes from concealing app bugs: correct-screen wrong-value failures must stop with the expectation unchanged.

## Kit compatibility

This tool is also a component of [android-kit](https://github.com/fridaysundaymood/android-kit/blob/main/IMPLEMENTATION_PLAN.md). From its first milestone it follows the shared `kit-schema` v1 result contract, independent `maestroFlow` configuration, run-scoped artifacts, `maestro_flow_*` MCP names, library-first design, and tests against the shared synthetic `kit-fixture-app`.
