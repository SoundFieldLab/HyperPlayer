# HyperSoundEngine v1.5.1 provenance

This directory records the reproducible source selection approved for HyperPlayer's HSE vendoring. It does not contain vendored HSE source code.

## Source identity

- Project: HyperSoundEngine
- Version/tag: `1.5.1` / `v1.5.1`
- Tag object: `3602b86906e6a345baaf6e87fe559f80ed399cc4`
- Commit: `f7017621b7d84005fbfed8a3c42a119487a17326`
- Repository: `https://github.com/IceFireIcer/HyperSoundEngine.git`
- Project-specific authorization: [`../../LICENSE-HSE-AUTHORIZATION.md`](../../LICENSE-HSE-AUTHORIZATION.md)

> Portions derived from HyperSoundEngine v1.5.1, Copyright IceFireIcer, used under a project-specific authorization.

`SOURCE-MANIFEST.json` is generated and verified from the source checkout, never from a vendor destination. The default checkout is `../../temp/hse-v1.5.1` relative to this directory.

## Selected source

- Rust `hse-core`: `HyperSoundEngineRust/crates/hse-core` (`Cargo.toml`, `src/**/*.rs`, and `tests/**/*.rs`).
- Rust `hrtf-core`: `HyperSoundEngineRust/crates/hrtf-core` (`Cargo.toml`, `src/**/*.rs`, and `tests/**/*.rs`); benchmarks are not selected.
- TypeScript core: `src/analysis/**/*.ts`, `src/dsp/**/*.ts`, `src/engine/**/*.ts`, `src/spatial/**/*.ts`, `src/index.ts`, `src/interfaces.ts`, and `src/types.ts`, excluding `src/spatial/test/**`.
- Shared source fixtures: `specs/engine/vectors/default-params.48000.json`, `specs/engine/vectors/scenes.48000.json`, and `specs/io/vectors/wav-standard.json`.

The manifest contains one SHA-256 for every selected tracked source file. Its aggregate SHA-256 hashes lines in source-path order using the format documented in the manifest.

## Destination relocation and adaptations

The three selected JSON fixtures are relocated in HyperPlayer under `crates/hyperplayer-hse-core/tests/fixtures/`: the two engine vectors go to `engine/`, and the WAV vector goes to `io/`. Five adaptations are recorded in `SOURCE-MANIFEST.json`: the `include_str!` paths in upstream `params.rs`, `scenes.rs`, and `wav.rs` point to those relocated fixtures; the vendored TypeScript `src/index.ts` omits exports for the unselected `offline` and WAV I/O modules so its public surface stays within the approved TypeScript scope; and `hse-core/src/fft.rs` restores the mandatory `Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.` fdlibm notice and `Copyright 2016 the V8 project authors. All rights reserved.` notice before the copied `ts_trig` implementation without changing its algorithm.

A further destination-only integration policy is documented here: `hse-core/src/lib.rs` adds a crate-level allow list limited to the rustc and Clippy lint categories observed under HyperPlayer's strict `-D warnings` build. It preserves the authorized snapshot's algorithm constants, NaN idioms, indexed DSP loops, compatibility forms, and behavior-spec tests while leaving unlisted current and future warnings denied. This policy is not source selection metadata, so it is intentionally absent from the verifier-generated manifest.

Manifest file paths and SHA-256 values always describe the clean pinned source checkout. They remain source hashes and therefore do not attest byte-for-byte identity of these intentionally adapted destination files. Adding the destination lint policy does not change any recorded source hash or the aggregate source hash.

## Explicit exclusions

The selection excludes HSE UI, browser host/integration and AudioWorklet code, service processes, WASAPI integration, N-API bindings, WASM bindings and pilot host, generated build artifacts, installed dependencies, and all SOFA/HRTF datasets or other binary assets. In particular, `ui/**`, `src/browser.ts`, `src/integration/**`, `src/worklet*`, `HyperSoundEngineRust/crates/{hse-service,hse-wasapi,hse-napi,hse-wasm}/**`, `HyperSoundEngineRust/web/**`, `dist/**`, `node_modules/**`, `HyperSoundEngineRust/target/**`, and dataset extensions such as `.sofa`, `.hrtf`, and `.bin` are not selected.

`HyperSoundEngineRust/crates/hrtf-core/src/sofa.rs` is selected source code for parsing; no SOFA dataset is selected or authorized by this record.

The vendored HSE source and HyperPlayer dependencies retain their applicable third-party notices. In particular, the V8/fdlibm notices and license are recorded in `THIRD_PARTY_NOTICES.md`, `NOTICE`, and `third_party_licenses/V8-BSD-3-Clause.txt`; the `sofar` 0.3.0 port retains the libmysofa and John Tsiombikas KD-tree attributions in `THIRD_PARTY_NOTICES.md`.

## Verification

From the HyperPlayer repository root:

```sh
node provenance/hse-v1.5.1/verify-source-manifest.mjs
```

To verify another clean checkout of the same tag and commit:

```sh
node provenance/hse-v1.5.1/verify-source-manifest.mjs /path/to/HyperSoundEngine
```

Maintainers may regenerate the manifest only from a clean checkout at the pinned commit:

```sh
node provenance/hse-v1.5.1/verify-source-manifest.mjs --write /path/to/HyperSoundEngine
```
