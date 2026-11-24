# Personal OpenCodex

Repository: `colthreepv/opencodex`. Branch: `personal`.
Base: upstream `v2.100.8` (`9e0e298ef9720cfeaa1209f090a68e4d1965d2a1`).
Release: `v2.100.8-personal.1`.

## Runtime alignment

This build uses the upstream runtime without product patches.
The previous OpenCode Responses carry is superseded by merged PR #8856
(`d56f721d1`), which chooses Responses or Chat per model instead of forcing
every OpenCode V2 model onto Responses.
The previous global Responses instructions-as-developer carry is retired.
Upstream PR #8194 (`25deb4d7c`) provides the targeted Anthropic OAuth
compatibility option `providers.anthropic.anthropicOAuthUserInstructions: true`.
Deployment enables this option on each existing Anthropic OAuth provider.

This migration is intentionally narrower by destination: caller system instructions
move into user content only for translated Anthropic OAuth calls. API-key and other
providers keep upstream instruction semantics. Explicit caller system items also
participate in the OAuth opt-in. Proxy-owned internal prompts remain protected.
The old general parser patch must not be stacked over the upstream implementation.

Dictation, native display names, GPT-6.2 catalog metadata and native Ultrafast are
already upstream. Existing operator labels remain configuration.

## Fork release tooling

The only fork changes are version stamps, this document, the Personal build workflow,
its contract test and test-layout registrations. The workflow is carried from
`v2.100.0-personal.1`: pinned actions, read-only build, successful-build dependency,
push-only publication, annotated tag target equal to the built commit, artifact
checksums and provenance. No npm publication.
Use annotated `v*-personal.*` tags on `colthreepv/opencodex`. Manual dispatch
builds an artifact only. Install the release tarball through the existing host launcher.

## Validation

- `bun install --frozen-lockfile`, `bun run typecheck`,
  `bun run privacy:scan` and `bun run structure:check` passed.
- Focused upstream compatibility and fork-contract tests: 245 passed, no failures.
  Files cover Anthropic OAuth caller/internal system wire, client config export,
  OpenCode refresh/launcher, native Ultrafast, personal build, file-size and hygiene.
- `bun run test -- tests/test-layout.test.ts tests/test-layout-tooling.test.ts`:
  three EPERM failures on the old untracked routing probe in the working checkout.
  Same command on a clean tracked-tree copy of HEAD: 29 passed, no failures.
- Full suite omitted because the product runtime is byte-identical to the stable
  release and the focused set covers the replaced custom contracts and fork tooling.
  Broader product behavior relies on upstream stable validation.
- Exact-tag build, GUI packaging and release results are recorded in GitHub Actions.