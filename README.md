# cc-gui

Desktop GUI wrapper for [cutecontainer](../cutecontainer) — drag a file in,
auto-compress / decompress; flip a tab, password-lock / unlock.

## Stack

- Tauri 2 + Vite + React + TypeScript
- Shells out to the prebuilt `cutecontainer-cli` binary (no FFI)

## Resolving the CLI

`cc-gui` looks for `cutecontainer-cli` in this order:

1. `CC_CLI` env var (absolute path)
2. sibling of the running executable (Tauri sidecar — production bundles)
3. `../../cutecontainer/build/cutecontainer-cli` relative to the running app
   (the playground dev layout)
4. plain `cutecontainer-cli` on `$PATH`

To build the CLI for dev, see [cutecontainer/build.sh](../cutecontainer/build.sh).

## Run

```sh
npm install
npm run tauri dev
```

## Build (unsigned, dev)

```sh
npm run tauri build
```

## Release (signed installer)

`package-release.sh` stages `cutecontainer-cli` as a Tauri sidecar and runs a
signed bundle build. By default it ad-hoc signs (`APPLE_SIGNING_IDENTITY=-`),
which produces a working `.app` and `.dmg` for local/internal distribution.
Gatekeeper will block ad-hoc signed apps on first launch — right-click → Open,
or distribute via a channel that bypasses Gatekeeper.

```sh
# build cutecontainer-cli first
(cd ../cutecontainer && ./build.sh)

# ad-hoc signed
./package-release.sh

# Developer ID + notarization
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_API_KEY=<key-id>
export APPLE_API_ISSUER=<issuer-uuid>
export APPLE_API_KEY_PATH=/path/to/AuthKey_<id>.p8
./package-release.sh
```

Outputs land in `src-tauri/target/release/bundle/`.

## v0 scope

- compress / decompress (auto-detect by `.cute` extension)
- lock / unlock (password-encrypted via depo)

Out of scope for now: depo multi-file archives, depo lock modes
(timed/fused/delayed), film/spectral, info panel, sidecar bundling for
distribution.

## Follow-ups

- Bundle `cutecontainer-cli` as a Tauri sidecar so production builds don't
  need the playground sibling layout.
- Replace shell-out with linked `libcutecontainer.a` if FFI overhead is
  worth removing the subprocess hop.
