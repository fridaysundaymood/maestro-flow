# Changelog

## Unreleased

- Add resource indexing, flow linting, structured journey generation, device-run reporting, and CLI and MCP adapters.
- Introduce lint rules MF001–MF008. Rule IDs are stable; future breaking rule behavior will be recorded here.
- Add agent-neutral workflow guidance and cross-platform CI.
- Support Maestro through 2.12.1 and classify evidenced System UI ANRs as environment failures.
- Avoid stale-selector errors for flow-entered values, interpolations, and Maestro regex selectors; report unresolved selectors as potentially dynamic content.
- Rule set 1.1.0 normalizes Android resource text, recognizes entered-text tokens, and limits stale errors to close matches or explicit stale-copy annotations. Lint discovers flow directories by default and reports relative paths.
