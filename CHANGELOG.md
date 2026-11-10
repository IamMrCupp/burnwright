# Changelog

## [0.5.0](https://github.com/IamMrCupp/burnwright/compare/v0.4.0...v0.5.0) (2026-11-10)


### Features

* **engine:** drive the minipro CLI for detect, read, write, verify, blank check and erase ([e1d8d12](https://github.com/IamMrCupp/burnwright/commit/e1d8d12d658b5fe6944eb46fb7562b6bf929ba4c))
* **engine:** run the bundled minipro sidecar with its own chip databases ([2743ab3](https://github.com/IamMrCupp/burnwright/commit/2743ab3caf65343370ec7f197c3aaa4607d0f825))
* **hexview:** in-app hex editor with undo/redo, find/replace and selection ([401b796](https://github.com/IamMrCupp/burnwright/commit/401b7965ba905a4d3f2ef764b9c17ce351ee1ff2))
* **release:** ship minipro, its databases and licences inside every installer ([a62eace](https://github.com/IamMrCupp/burnwright/commit/a62eace5bab980fd05b7eb7a3080398e5ebb08b4))


### Bug Fixes

* **sidecar:** check the Windows build links the pinned zlib ([25efa38](https://github.com/IamMrCupp/burnwright/commit/25efa381223a2c4ec44f19cb4aa723d5c1d429a3))
* **sidecar:** grep captured deb and ldd listings instead of pipes ([750fbbf](https://github.com/IamMrCupp/burnwright/commit/750fbbf389da3f3720abe644727dcf37a4ec1938))
* **sidecar:** run under macOS bash 3.2 and match Tauri's deb paths ([926032b](https://github.com/IamMrCupp/burnwright/commit/926032b656cc37add033544aacc6c2310b9b4700))
* **ui:** drop the stale note that engine commands are stubbed ([75e6d2b](https://github.com/IamMrCupp/burnwright/commit/75e6d2b8b7844b214d654cc80a943d7b753da560))

## [0.4.0](https://github.com/IamMrCupp/burnwright/compare/v0.3.0...v0.4.0) (2026-11-10)


### Features

* **app:** show a read-vs-file diff of generated sample buffers ([8edead9](https://github.com/IamMrCupp/burnwright/commit/8edead9456e1c434b0ff50c213f938da9d0cb353))
* **hexview:** add a diff view with highlighting and difference navigation ([8edead9](https://github.com/IamMrCupp/burnwright/commit/8edead9456e1c434b0ff50c213f938da9d0cb353))
* **hexview:** add a range-based byte buffer diff with fixture tests ([8edead9](https://github.com/IamMrCupp/burnwright/commit/8edead9456e1c434b0ff50c213f938da9d0cb353))
* **release:** attach unsigned installers and SHA256SUMS to each GitHub release ([649275a](https://github.com/IamMrCupp/burnwright/commit/649275aed571323a67e1593267e902f649b5203d))

## [0.3.0](https://github.com/IamMrCupp/burnwright/compare/v0.2.0...v0.3.0) (2026-11-09)


### Features

* **app:** show a generated sample buffer in the hex viewer ([3a556dc](https://github.com/IamMrCupp/burnwright/commit/3a556dc4fd8924e5a087710dc3b736a880c18dad))
* **engine:** load and save raw bin and Intel HEX images ([b8b9e96](https://github.com/IamMrCupp/burnwright/commit/b8b9e968a36a00e94b0e85cf5e1c70d18d9616b6))
* **engine:** spawn minipro and parse its stderr progress with cancellation ([6a41651](https://github.com/IamMrCupp/burnwright/commit/6a4165146e1d0c6f965d52731eed921b6f188ba9))
* **hexview:** add a virtualised hex viewer component with Vitest tests ([62a7a17](https://github.com/IamMrCupp/burnwright/commit/62a7a17114ed4e40a7d9c3bcd62f279319d34b68))


## [0.2.0](https://github.com/IamMrCupp/burnwright/compare/v0.1.0...v0.2.0) (2026-11-09)


### Features

* **app:** show burnwright and minipro versions in the UI ([4798cba](https://github.com/IamMrCupp/burnwright/commit/4798cbaaabe6bcd43facaf5b5e7a4b1598c98268))
* **scaffold:** app shell, rust workspace, minipro 0.7.4 submodule, engine command contract ([00ec15c](https://github.com/IamMrCupp/burnwright/commit/00ec15c62b6c410c9be8ac774ccea82b472010bd))


### Bug Fixes

* **bundle:** use com.mrcupp.burnwright as the bundle identifier ([ad5e73f](https://github.com/IamMrCupp/burnwright/commit/ad5e73f1e0a67c6407d4714336902f5b8b7d4ab4))
* **release:** match Cargo.lock members via name.value, drop component from tag ([b5673bd](https://github.com/IamMrCupp/burnwright/commit/b5673bdd2c62d1d2ede4e7433ef910742a693de5))
