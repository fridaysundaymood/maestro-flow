# Changelog

## Unreleased

- Leave unexplained flow failures unclassified rather than attributing them to tests.
- Probe leased devices before runs and report quarantine evidence for safe suite recovery.
- Declare and bundle emu-lab for lease-backed runs, and verify scheduler loading with a synthetic lease database.
- Add resource indexing, flow linting, structured journey generation, device-run reporting, and CLI and MCP adapters.
- Introduce lint rules MF001–MF008. Rule IDs are stable; future breaking rule behavior will be recorded here.
- Add agent-neutral workflow guidance and cross-platform CI.
- Support Maestro through 2.12.1 and classify evidenced System UI ANRs as environment failures.
- Avoid stale-selector errors for flow-entered values, interpolations, and Maestro regex selectors; report unresolved selectors as potentially dynamic content.
- Rule set 1.1.0 normalizes Android resource text, recognizes entered-text tokens, and limits stale errors to close matches or explicit stale-copy annotations. Lint discovers flow directories by default and reports relative paths.
- Refresh the resource index automatically before linting when its version or input hash changes.
