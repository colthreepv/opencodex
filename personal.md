# Personal OpenCodex build

This is the build plan for `colthreepv/opencodex`. Its default branch is `personal`.
Start from the latest upstream stable release, carry the selected changes below,
test the combined code, then build a downloadable npm package on this fork.
Do not publish to the upstream npm package or install/restart a running service here.

## Current base

- Upstream stable: `v2.98.0`, published 2026-11-07.
- Release commit: `36aa9e8f7933807dc2c873bb93051c7c9c00f4e6`.
- Preparation status: none of the product changes below has been applied to `personal` yet.
- The package keeps upstream's version. The build's `provenance.json` records the fork commit.

## Changes to carry

Apply these in order. The feature branches were based on `dev`, so do not merge
their full histories into a stable-based branch. Cherry-pick the listed product
commits with `-x`. Skip commits whose changes have already shipped upstream.

| Order | Source branch | Commits, in order | Intent and checks | Status |
| --- | --- | --- | --- | --- |
| 1 | `codex/dictation-scribetray-stream` | `838a54b21`, `c1c01f570`, `74d1ad153` | Ten-minute recordings, ScribeTray streaming frames and neutral handling of local budget expiry. Run `tests/server/audio-dictation.test.ts`. Keep frame validation and cancellation limits. Upstream PR #8232. | Pending |
| 2 | `fix/native-export-display-names` | `c466d0968`, `fc5fd094a` | Preserve configured native model display names in exports and management GET. Run `tests/codex-integration/model-display-names-management-api.test.ts`. Do not pick merge commit `810d9d270`. Upstream PR #8234. | Pending |
| 3 | `opencode-responses` | `49eae702c` | Configure OpenCode V2 for Responses through export, Connect, launcher and refresh. Preserve the separate legacy V1 block and admission headers. Run the client export, managed-refresh and OpenCode CLI tests changed by this commit. | Pending |
| 4 | `responses-instruction-normalization` | `7c037d750` only | Normalize Responses caller `instructions` as leading developer input. Anthropic's existing mapping sends it as user content. Preserve explicit system messages, proxy checkpoint guidance, Chat/Messages semantics, raw passthrough and reparsing. Run `tests/responses/responses-instructions-developer.test.ts` plus parser, retention and adapter regressions. | Pending |

Pick order 3 before order 4. The fourth branch already contains the third commit
as an ancestor, so pick only `7c037d750`, not its entire branch history.
Resolve test-layout registry conflicts by keeping stable's existing entries and
adding only the new test entries. Check file-size limits rather than raising them.
Update each row after applying and testing it, including the new personal commit.

## Exclusions

- Do not merge `archive/local-fork-20261107`. It is historical only. No build or
  update step depends on it. Do not carry its installer, update worker, automatic
  rollback or service-restart helpers; installation and restart stay manual.
- Do not carry `opencode/anthropic-support` or PR #8194 alongside instruction normalization.
  It is a different implementation. The selected path does not change the Anthropic adapter.
- Other pricing, model-policy, provider, UI and test-cleanup branches are not selected
  automatically. Add a row here before carrying another change. Do not reapply already
  merged work, such as `codex/unknown-compaction-compatibility`, upstream PR #6236.
- Do not change upstream release branches, tags, npm ownership, signing or release automation.

## Updating the base

1. Fetch upstream and check its latest non-prerelease release. Use the release tag,
   not the tip of `dev` and not an old `main` branch in this fork.
2. On `personal`, merge the next stable tag without rewriting published history.
   Keep the previous successful personal commit as the rollback point.
3. Recheck every carry against that release. Remove shipped patches from this plan,
   resolve remaining conflicts, and update the base tag/commit above.
4. Run focused regressions for each carry and `bun run typecheck`. Record commands,
   failures and untested cases here before calling the build usable. A successful
   package build alone does not verify all providers.

No full suite or `test:changed` is run during this preparation, as requested.
Existing Windows layout scans can encounter an inaccessible scratch directory;
do not delete unrelated scratch to make those scans pass.

## Building on this fork

The `Personal build` workflow is manual and accepts only this repository's `personal`
branch. It runs one Ubuntu job, installs the pinned dependencies, runs the workflow
regression test and typecheck, builds the dashboard, then creates an npm tarball.
It uploads the tarball, this plan, `provenance.json` and `SHA256SUMS` as an artifact.
It does not create a GitHub release, publish to npm or install the package anywhere.

```sh
gh workflow run personal-build.yml --repo colthreepv/opencodex --ref personal
gh run list --repo colthreepv/opencodex --workflow personal-build.yml --limit 1
gh run view <run-id> --repo colthreepv/opencodex
gh run download <run-id> --repo colthreepv/opencodex --dir ./personal-artifact
```

Check the run's head commit against `provenance.json`, then verify `SHA256SUMS`.
The package is installable through npm; this is not a standalone executable build.
Installation and service restart remain separate manual operations.

## Preparation verification

This branch initially contains only this plan and the fork-only build workflow/tests.
All product rows remain pending. The installed local runtime is separate and unchanged.
Local preparation checks passed: 24 focused tests, 23 platform-dependent skips,
`bun run typecheck`, `bun run privacy:scan`, the frozen dependency install,
`bun run build:gui`, and `npm pack --ignore-scripts`. The local tarball is about 20 MB.
This does not claim that a GitHub Actions run or the pending product carries passed.
The workflow has read-only repository permissions, no secrets or publication steps,
pinned external actions and disabled checkout credential persistence. It cannot run
from another repository or branch. This is not upstream maintainer approval.
