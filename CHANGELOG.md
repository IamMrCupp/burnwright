# Changelog

## [0.12.2](https://github.com/IamMrCupp/burnwright/compare/v0.12.1...v0.12.2) (2026-11-18)


### Bug Fixes

* **ui:** hold operations and the other file panels while the T76 algorithm file is being chosen ([d762bde](https://github.com/IamMrCupp/burnwright/commit/d762bde0ef5d49b5cad8dee11429fdca7506fff6))
* **ui:** say so when the remembered T76 algorithm file can't be applied, and try again at the next detect ([49d418e](https://github.com/IamMrCupp/burnwright/commit/49d418efebd7285e40de652ede8f2e841b5e0c86))

## [0.12.1](https://github.com/IamMrCupp/burnwright/compare/v0.12.0...v0.12.1) (2026-11-17)


### Bug Fixes

* **ui:** say a T76 algorithm-file failure comes before any read or write, not before the chip is touched ([294914c](https://github.com/IamMrCupp/burnwright/commit/294914cb570fd612b5c25fcb625cdfd5b2bed3e9))

## [0.12.0](https://github.com/IamMrCupp/burnwright/compare/v0.11.0...v0.12.0) (2026-11-17)


### Features

* **engine:** add a Backend trait and a Bench layer that requires a backup before any write ([c7835d2](https://github.com/IamMrCupp/burnwright/commit/c7835d208e3a30e084eb92b009b4926a88d59394))

## [0.11.0](https://github.com/IamMrCupp/burnwright/compare/v0.10.2...v0.11.0) (2026-11-17)


### Features

* **engine:** report a T76 operation that fails for want of algorithm.xml as its own error, and pass the user's file to minipro ([f558af5](https://github.com/IamMrCupp/burnwright/commit/f558af5787afb5821da68ae5eef9599fd2a88202))
* **ui:** explain a T76 with no algorithm file and let the user choose their own ([f558af5](https://github.com/IamMrCupp/burnwright/commit/f558af5787afb5821da68ae5eef9599fd2a88202))

## [0.10.2](https://github.com/IamMrCupp/burnwright/compare/v0.10.1...v0.10.2) (2026-11-17)


### Bug Fixes

* **app:** don't close the window over a running write or an unsaved buffer without asking ([51ac398](https://github.com/IamMrCupp/burnwright/commit/51ac398b4ed6781fcdf276217a5b3d0c15be97a5))
* **engine:** never hand minipro Intel HEX or S-record text, which it decodes instead of writing ([b1e8a8b](https://github.com/IamMrCupp/burnwright/commit/b1e8a8bec40ef09355e85c09a73058ec0cd9b006))
* **ui:** ask before replacing a chip read that was never saved to a file ([f9c7f7c](https://github.com/IamMrCupp/burnwright/commit/f9c7f7c33216dd0f78fe1810b506d57fcc66c487))
* **ui:** compare firmware versions by the part that is the firmware, so newer doesn't read as older ([b8fa0c1](https://github.com/IamMrCupp/burnwright/commit/b8fa0c1e60910d7877d5b868552745d91c70b4c1))
* **ui:** say an all-ones or all-zeros chip ID usually means no chip in the socket ([1edb597](https://github.com/IamMrCupp/burnwright/commit/1edb597f807752ebe9a173b2cc484b5629bc1cbf))

## [0.10.1](https://github.com/IamMrCupp/burnwright/compare/v0.10.0...v0.10.1) (2026-11-17)


### Bug Fixes

* **release:** retry stapler when Apple's ticket lookup drops its connection ([c38d2ad](https://github.com/IamMrCupp/burnwright/commit/c38d2add95c67ba263842d6a3008fc2828837b5d))

## [0.10.0](https://github.com/IamMrCupp/burnwright/compare/v0.9.0...v0.10.0) (2026-11-17)


### Features

* **app:** add the system file dialogs for opening and saving images ([a29fbcf](https://github.com/IamMrCupp/burnwright/commit/a29fbcf48ff43d7dd50a34c0b27fbd815972924d))
* **app:** pass minipro's check overrides and new error kinds through the engine wrapper ([3b39bb3](https://github.com/IamMrCupp/burnwright/commit/3b39bb31224eedf9db338567b5af0af138b4bf35))
* **engine:** report chip ID and image size mismatches as their own errors, with overrides and the command line for a log ([35fb3de](https://github.com/IamMrCupp/burnwright/commit/35fb3dedfa3a17a84852d90c15716ad4e7d69bb7))
* **ui:** add the buffer panel with open, save and the size check ([e4b9c80](https://github.com/IamMrCupp/burnwright/commit/e4b9c80f69ca88bc719f0850b2fbf3332ba5eb89))
* **ui:** add the device screen's state, controller and a fake engine to test it against ([fa0dd2a](https://github.com/IamMrCupp/burnwright/commit/fa0dd2a9c11e8f4bc6b409580b40f6b7bdc8e1c9))
* **ui:** add the log pane ([a1a0e0d](https://github.com/IamMrCupp/burnwright/commit/a1a0e0db201505d1588fb39625fa7f30fb1d9145))
* **ui:** add the operations panel with progress, cancel and confirmations ([1c95b3a](https://github.com/IamMrCupp/burnwright/commit/1c95b3a68f0a6275122446e3bf6141faff74fbd6))
* **ui:** add the programmer bar and the chip picker ([901d97e](https://github.com/IamMrCupp/burnwright/commit/901d97e65b2d102197d7a7a8db572c06e33ca848))
* **ui:** replace the demo page with the device screen ([6ff11e2](https://github.com/IamMrCupp/burnwright/commit/6ff11e238ec31240dbd2d3d9b0cde4c8236f4f53))


### Bug Fixes

* **ui:** keep file loads and saves from landing under an operation or its confirmation ([8790f7d](https://github.com/IamMrCupp/burnwright/commit/8790f7d243e9dd763bfb6cbb6a5f097b664e1670))
* **ui:** keep long chip names on one line in the picker and punctuate the log's outcome line ([53e1f5c](https://github.com/IamMrCupp/burnwright/commit/53e1f5cc014b50b2e581c5c240db922040df0c03))

## [0.9.0](https://github.com/IamMrCupp/burnwright/compare/v0.8.1...v0.9.0) (2026-11-17)


### Features

* **app:** report the T76 build's version with its commit ([c00d24f](https://github.com/IamMrCupp/burnwright/commit/c00d24f319cddd991253847c6c981732ca2bee57))
* **app:** send T76 chip queries to the T76 build ([c00d24f](https://github.com/IamMrCupp/burnwright/commit/c00d24f319cddd991253847c6c981732ca2bee57))
* **engine:** read the T76 build's chip lists and chip info ([c00d24f](https://github.com/IamMrCupp/burnwright/commit/c00d24f319cddd991253847c6c981732ca2bee57))
* **engine:** route the T76 to its own minipro build ([c00d24f](https://github.com/IamMrCupp/burnwright/commit/c00d24f319cddd991253847c6c981732ca2bee57))

## [0.8.1](https://github.com/IamMrCupp/burnwright/compare/v0.8.0...v0.8.1) (2026-11-17)


### Bug Fixes

* **engine:** give no image size for chips with a zero code memory ([9f59a68](https://github.com/IamMrCupp/burnwright/commit/9f59a688dc5fd933bf17f5ade6abd5667c54c69e))
* **engine:** report a chip entry minipro can't parse as its own error, not an unknown chip ([1b360a8](https://github.com/IamMrCupp/burnwright/commit/1b360a85e607b5b4462d4f980acbbaf3b75504d1))

## [0.8.0](https://github.com/IamMrCupp/burnwright/compare/v0.7.0...v0.8.0) (2026-11-12)


### Features

* **app:** add list_chips, search_chips and chip_info commands ([8d09c94](https://github.com/IamMrCupp/burnwright/commit/8d09c9493be03a019317145a5802cc9f20d084dd))
* **engine:** list chips with -l, through a pass-through pager on Windows ([7069d7f](https://github.com/IamMrCupp/burnwright/commit/7069d7fcd2d2c839fc6e6d9f4d73ad62543e9629))
* **engine:** list, search and describe the chips minipro knows ([03675f0](https://github.com/IamMrCupp/burnwright/commit/03675f08a52273038712e60a8ffdabfd119409f9))
* **ui:** add chip list, search and info to the engine bindings ([cd23271](https://github.com/IamMrCupp/burnwright/commit/cd23271381a702e0d8d55e90ee994be999dcd2a8))

## [0.7.0](https://github.com/IamMrCupp/burnwright/compare/v0.6.0...v0.7.0) (2026-11-10)


### Features

* **engine:** diagnose a T76 stuck on a USB 3 link on macOS ([2680c57](https://github.com/IamMrCupp/burnwright/commit/2680c575bc496b5f90ec9451227c54c7464860ca))
* **engine:** report minipro's firmware and support warnings from detect ([3c2eb0c](https://github.com/IamMrCupp/burnwright/commit/3c2eb0c9b98d0128a5b7537c1d5e3bce563a6195))
* **ui:** show firmware warnings after detect and the T76 USB 2.0 fix ([f5e70b1](https://github.com/IamMrCupp/burnwright/commit/f5e70b1825381fab918403b56cbf6defc6248d84))

## [0.6.0](https://github.com/IamMrCupp/burnwright/compare/v0.5.0...v0.6.0) (2026-11-10)


### Features

* **app:** add diagnose_programmer command ([bce4828](https://github.com/IamMrCupp/burnwright/commit/bce48289db0d7f435a4598bd8ee33e46b6317a81))
* **deb:** install udev rules so a non-root user can open the programmer ([62ae7be](https://github.com/IamMrCupp/burnwright/commit/62ae7be7df1437a1671def55c29a0dd14d0ec31d))
* **engine:** diagnose why no programmer was found ([1f091bd](https://github.com/IamMrCupp/burnwright/commit/1f091bdb433220bab644cd537f080a23154fb801))
* **ui:** explain why no programmer was found ([cde70d7](https://github.com/IamMrCupp/burnwright/commit/cde70d77a5eec7a25598ac6ff357fe15b1347baa))


## [0.5.0](https://github.com/IamMrCupp/burnwright/compare/v0.4.0...v0.5.0) (2026-11-10)


### Features

* **engine:** drive the minipro CLI for detect, read, write, verify, blank check and erase ([e1d8d12](https://github.com/IamMrCupp/burnwright/commit/e1d8d12d658b5fe6944eb46fb7562b6bf929ba4c))
* **engine:** run the bundled minipro sidecar with its own chip databases ([2743ab3](https://github.com/IamMrCupp/burnwright/commit/2743ab3caf65343370ec7f197c3aaa4607d0f825))
* **hexview:** in-app hex editor with undo/redo, find/replace and selection ([401b796](https://github.com/IamMrCupp/burnwright/commit/401b7965ba905a4d3f2ef764b9c17ce351ee1ff2))
* **release:** ship minipro, its databases and licences inside every installer ([a62eace](https://github.com/IamMrCupp/burnwright/commit/a62eace5bab980fd05b7eb7a3080398e5ebb08b4))


### Bug Fixes

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
