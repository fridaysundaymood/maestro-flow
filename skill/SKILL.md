---
name: maestro-flow
description: Author and iterate Maestro flows using Android resources and device evidence.
---

# Maestro flow workflow

Use synthetic data only. Read `e2e/maestro/CONVENTIONS.md` when present. Keep accessibility hierarchies and screenshots local unless explicitly authorized to share them.

1. Refresh the resource and semantics index with `maestro-flow index` or `maestro_flow_index`.
2. Turn the requested journey into a table of steps and expected UI. Generate the flow with `maestro-flow generate` or `maestro_flow_generate`; prefer content descriptions, resource text, then resource-derived regexes.
3. Run `maestro-flow lint` or `maestro_flow_lint`; fix findings using resource or hierarchy evidence.
4. Run the flow alone on a clean device with `maestro-flow run` or `maestro_flow_run`. Classify failures from evidence as stale selectors, navigation, timing, or app bugs. Make at most three evidence-supported flow repairs; do not edit app code or change expected values to conceal a bug.
5. Run the full suite once with the same run operation to detect state leakage.
6. Record observed app conventions and report the result and evidence. Coordinate taps are accessibility findings, not preferred selectors.

A person can perform the same workflow with the CLI; MCP is optional. Use `maestro-flow doctor` or `maestro_flow_doctor` to diagnose prerequisites.
