# Journey-to-Maestro skill: implementation plan

## Status

Planning only. The skill, helper CLI, linter, and device integration described here are not implemented.

## Problem and goal

Hand-authored UI journeys can break when copy or navigation conventions change. Selectors recalled from memory and assertions that match unrelated values make failures hard to diagnose. Build a skill and small helper CLI that turn a written journey into a robust Maestro flow grounded in Android string resources and the accessibility tree, then iterate on a device until it passes or an app bug is supported by evidence.

Non-goals: replacing instrumented logic tests or visual regression testing.

## Inputs and outputs

- Input: a plain-language journey or a table of steps and expectations, app package, target locale, and optional currency or state preconditions.
- Output: `e2e/maestro/NN-<slug>.yaml`, including a short intent header, and a run report with either a pass or an evidence-backed failure classification.

## Components

### Resource index

- Parse `res/values*/strings*.xml`, including plurals and arrays, into a key-to-locale index. Convert format arguments into suitable selector regexes, for example `%1$s spent this month` to `.* spent this month.*`.
- Inspect Compose source for literal `contentDescription` and `semantics` values and `stringResource(R.string.x)` usage, mapping resource keys to screens where possible.
- Produce `selectors.json` for authoring and linting. Account for semantics merging by consulting a real merged accessibility hierarchy, not source alone.

### App conventions

Maintain an app-specific `e2e/maestro/CONVENTIONS.md`, seeded from observed hierarchies and failures. Examples include waiting for a stable launch anchor, using tabs rather than Back on root screens, tapping the action exposed by a swipe-to-delete, hiding the keyboard before selecting obscured controls, and scrolling to off-screen settings. The skill reads the file before authoring and records newly observed conventions after fixes; these examples are not universal assumptions.

### Flow generator

- Generate a launch with cleared state and retry, a stable anchor wait, necessary locale/currency or other state preconditions, journey steps, and assertions.
- Prefer content descriptions, then resource-backed exact text, then regexes derived from format strings. Use coordinates only when an element has no semantics, and flag the accessibility finding.
- Scope money assertions to a screen container or use a complete label rather than a bare number; assert the new value is present and the old value absent.

### Linter

- Resolve every literal selector against current string resources or content descriptions and report stale selectors before a device run. Incorporate merged hierarchy evidence where source semantics alone are insufficient.
- Flag Back on root screens, bare numeric assertions, missing launch anchor waits, and coordinate taps.
- Run in CI so copy changes surface before device execution. Diagnostics should identify the flow and offending selector or rule.

### Device iteration

Use Device Lab MCP when available, otherwise run `maestro test` against the supplied serial. Inspect the failure hierarchy and classify: stale selector (expected screen, changed copy), navigation (wrong screen), timing (passes on rerun), or app bug (correct screen but wrong value, or crash). Repair the flow or add a wait where supported by the evidence; stop and report an app bug with evidence. Never change expected values to hide a bug or edit app code. Limit automatic fixes to three iterations per flow.

## Skill workflow

1. Read conventions and build or refresh `selectors.json`.
2. Express the journey as a step-to-expected-UI table.
3. Generate the flow, lint it, and fix lint findings.
4. Run it alone on a clean device and iterate under the classification rules.
5. Run the full suite once to detect inter-flow state leaks.
6. Record learned conventions and report results with evidence.

## Milestones

1. **M1 — Index and linter:** implement resource indexing and lint rules; exercise them against synthetic fixture flows, including a selector made stale by a copy change.
2. **M2 — Generator and conventions:** generate flows from synthetic journey descriptions and compare them with expected hand-authored YAML.
3. **M3 — Device iteration:** exercise classification and appropriate repairs using synthetic stale-selector, navigation, timing, and app-bug scenarios.
4. **M4 — Locales and CI:** generate flows for multiple locales from one journey and add a CI lint hook.

## Testing and risks

Use a synthetic fixture app and schema with known resources, semantics, navigation, and journey expectations. Mutate a fixture string and assert that dependent flows are flagged; use fixture journeys and expected YAML as golden cases. Test merged semantics against an actual hierarchy dump. Prevent over-eager fixes from concealing app bugs: correct-screen wrong-value failures must stop with the expectation unchanged.

## Kit compatibility

This tool is also a component of [android-kit](https://github.com/fridaysundaymood/android-kit/blob/main/IMPLEMENTATION_PLAN.md). From its first milestone it follows the kit composability rules: the shared result schema (`kit-schema`), its own section in `android-kit.yaml`, artifacts under `.android-kit/runs/<run-id>/<tool>/`, prefixed MCP tool names, a library-first design with thin CLI and MCP adapters, and tests against the shared synthetic `kit-fixture-app`.
