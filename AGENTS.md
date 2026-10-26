# Repository guidance

Use Node.js 22 or newer and built-in modules for the runtime implementation. Preserve the fixed command-hook protocol, owner-only storage, fail-open collector behavior and distinction between emitted context and provider usage.

Run `npm run check` before committing implementation changes. Keep install examples consistent with tested entrypoints and package contents. Verify archive installation when changing packaging or relative imports.

Keep documentation version-scoped and distinguish runtime probes, tagged source evidence, documentation and unverified behavior. Do not commit generated probe outputs, credentials, personal paths or private instruction text. External research helpers retain their upstream notices. Use Conventional Commits and keep changes scoped.
