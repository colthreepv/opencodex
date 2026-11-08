# Personal OpenCodex

Repository: `colthreepv/opencodex`. Default branch: `personal`.
Base: upstream `v2.99.0`, commit `667662903a6c139524506667d12656d9ad50fad0`.
Release: `v2.99.0-personal.1`. All changes below are applied.

## Included branches

| Source branch | Source commits | Personal commits | Intent |
| --- | --- | --- | --- |
| `codex/dictation-scribetray-stream` | `838a54b21`, `c1c01f570`, `74d1ad153` | `c3d8a665f`, `42eff62ef`, `8101d589c` | Ten-minute recordings, ScribeTray streaming frames and neutral local budget expiry. |
| `fix/native-export-display-names` | `c466d0968`, `fc5fd094a` | `f02c07434`, `d0fd5c239` | Preserve configured native model display names in exports and management GET. |
| `opencode-responses` | `49eae702c` | `6986d9abf` | OpenCode V2 uses Responses through export, Connect, launcher and refresh. Legacy V1 stays unchanged. |
| `responses-instruction-normalization` | `7c037d750` | `3e210b04f` | Responses caller instructions become leading developer input, which Anthropic maps to user content. Explicit system messages and Chat/Messages stay unchanged. |

Fork tooling (`Personal build` workflow, its test and this file) is carried as
`b525398c4`, `e5e0d92e0`, `31a2a0007` (workflow part of the previous release commit,
version bumps dropped), `8c89d7508`, `79dc45d3f`.

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

For `v2.99.0-personal.1`, carries were rebased from the previous personal commits;
none were already upstream. Conflicts were only test-registration entries (both kept)
and version files (stable kept, then synced). Local checks: `bun run typecheck` and the
carried tests plus test-layout, structure and repo-hygiene guards. Test-layout guards
need a checkout without unreadable leftover `.tmp-*` directories. CI results are
recorded in the tag's Actions run, not assumed from earlier builds.
Use fork release tarballs for updates, not the upstream npm updater.

## Install the latest release (Windows)

Run in non-administrator PowerShell 7 with GitHub CLI (`gh`):

```powershell
gh release download -R colthreepv/opencodex -p 'bitkyc08-opencodex-*.tgz' -O "$env:TEMP\opencodex-personal.tgz" --clobber &&
ocx stop &&
npm install -g --prefix "$env:LOCALAPPDATA\nvm\v24.22.1" "$env:TEMP\opencodex-personal.tgz" &&
Start-Process wscript.exe -ArgumentList ('"' + (Join-Path ([Environment]::GetFolderPath('Startup')) 'OpenCodex.vbs') + '"')
```

`&&` stops on failure. Replaces the existing Node `24.22.1` installation and uses
the existing user-login launcher. Do not run `ocx service install/repair/start`.
