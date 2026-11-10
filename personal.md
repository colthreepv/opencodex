# Personal OpenCodex

Repository: `colthreepv/opencodex`. Default branch: `personal`.
Base: upstream `v2.100.0`, commit `0d691be839b9c8ea489f66e0032e0f727dd92807`.
Release: `v2.100.0-personal.1`.

## Included branches

| Source branch | Source commits | Personal commits | Intent |
| --- | --- | --- | --- |
| `opencode-responses` | `49eae702c` | `3e497f203` | OpenCode V2 uses Responses through export, Connect, launcher and refresh. Legacy V1 stays unchanged. |
| `responses-instruction-normalization` | `7c037d750` | `a0f31fa0b` | Responses caller instructions become leading developer input. Explicit system messages and Chat/Messages stay unchanged. |

Stable already includes dictation/ScribeTray fixes through PR #8232 (`f2f3c6a81`)
and native model display names through PR #8234 (`97d26c75e`), including their
regressions. Their five personal commits were skipped. The affected runtime files
match the previous personal release byte for byte.

Fork tooling is carried as `b3c4f86d8`, `cd1b2f417`, `aa31f871a`,
`ec6d6130e`, and `c5baa01fb`. Registration conflicts preserve stable entries;
documentation conflicts preserve the current dev-branch links and diagnostics.

## Updating

Start from the latest upstream stable, not `dev`. Carry selected commits with
`git cherry-pick -x`, in the order above. Skip fixes already included upstream.
Pick only the instruction-normalization commit, not its Responses ancestor again.
Keep stable's test-layout entries and update this file with the new base and hashes.

Do not add installer, restart or automatic rollback helpers. Do not carry
`opencode/anthropic-support` or PR #8194, which use a different instruction mapping.
Other branches are excluded unless added here. Installation is a separate operation.

## Release

Set the version with `bun scripts/release-version-sources.ts sync <version>`,
commit and push `personal`, then push an annotated `v<version>` tag to `fork`.
Personal build CI builds the tagged commit and publishes a GitHub release containing
the npm tarball, provenance, checksums and this file. It does not publish to npm.
Manual dispatch builds an artifact without a release. Use fork tarballs for updates.

Validation for this release: typecheck, focused carry and already-upstream regression
tests, build-contract and repository guards, privacy scan, structure check and docs
build. The full suite is not run for this stable-based carry: focused tests cover
the changed contracts; broader upstream behavior relies on stable release validation.
Optional real OpenCode/Kilo binary tests are skipped without their opt-in environment.
Three layout assertions hit EPERM on an old untracked routing probe in this checkout;
the layout guards are checked again on a clean tracked-tree copy of the same HEAD.
Exact-head build and release evidence is in the tag's Personal build Actions run.
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
