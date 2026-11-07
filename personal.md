# Personal OpenCodex

Repository: `colthreepv/opencodex`. Default branch: `personal`.
Base: upstream `v2.98.0`, commit `36aa9e8f7933807dc2c873bb93051c7c9c00f4e6`.
Release: `v2.98.0-personal.1`. All changes below are applied.

## Included branches

| Source branch | Source commits | Personal commits | Intent |
| --- | --- | --- | --- |
| `codex/dictation-scribetray-stream` | `838a54b21`, `c1c01f570`, `74d1ad153` | `ec9abf94f`, `a37ed1d37`, `3fd6f2810` | Ten-minute recordings, ScribeTray streaming frames and neutral local budget expiry. |
| `fix/native-export-display-names` | `c466d0968`, `fc5fd094a` | `0b11a47ee`, `58f8c5a8b` | Preserve configured native model display names in exports and management GET. |
| `opencode-responses` | `49eae702c` | `6a2e9f443` | OpenCode V2 uses Responses through export, Connect, launcher and refresh. Legacy V1 stays unchanged. |
| `responses-instruction-normalization` | `7c037d750` | `3b3ae8787` | Responses caller instructions become leading developer input, which Anthropic maps to user content. Explicit system messages and Chat/Messages stay unchanged. |

## Updating

Start from the latest upstream stable, not `dev`. Carry the selected commits with
`git cherry-pick -x`, in the order above; do not import entire dev-based branch histories.
Skip fixes already included upstream. Pick only the listed instruction-normalization
commit, not its Responses ancestor again. Keep stable's test-layout entries when
resolving registration conflicts. Update this file with the new base and carried commits.

Do not add installer, restart or automatic rollback helpers. Do not also carry
`opencode/anthropic-support` or PR #8194, which implement a different instruction mapping.
Other branches are excluded unless added to this file. Installation stays manual.

## Release

Set the version with `bun scripts/release-version-sources.ts sync <version>`, commit
and push `personal`, then push an annotated `v<version>` tag to `fork`.
The fork's `Personal build` CI builds the tagged commit and publishes a normal GitHub
release with the npm tarball, provenance and checksums. It does not publish to npm
or install anything. Manual workflow dispatch builds an artifact without a release.

For `personal.1`, the user requested no repeat of the previously completed product
tests. The carries applied with only test-registration conflicts. CI results are
recorded in the tag's Actions run, not assumed from earlier builds.
Use fork release tarballs for updates, not the upstream npm updater.
