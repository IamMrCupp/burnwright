# shellcheck shell=bash disable=SC2034
# Pinned third-party sources for the minipro sidecar. Sourced by the other
# scripts in this folder; bump the version and hash together.
#
# libusb is statically linked into minipro on every platform. The hash is of
# the upstream release tarball, whose detached signature (.asc) verifies
# against the release manager key in https://github.com/libusb/libusb/blob/master/KEYS
# (Tormod Volden, C681 8737 9B23 DE9E FC46 651E 2C80 FF56 C683 0A0E).
LIBUSB_VERSION=1.0.30
LIBUSB_SHA256=fea36f34f9156400209595e300840767ab1a385ede1dc7ee893015aea9c6dbaf
LIBUSB_URL="https://github.com/libusb/libusb/releases/download/v${LIBUSB_VERSION}/libusb-${LIBUSB_VERSION}.tar.bz2"

# Upstream minipro, vendored as the vendor/minipro submodule.
MINIPRO_UPSTREAM=https://gitlab.com/DavidGriffith/minipro

# Name of the sidecar. Not plain "minipro": Tauri installs externalBin to
# /usr/bin on the .deb, where "minipro" would clash with distro packages.
SIDECAR_NAME=burnwright-minipro

# zlib, statically linked into the Windows build only (macOS and Linux use the
# OS's own libz). Signed by Mark Adler, 5ED4 6A67 21D3 6558 7791 E2AA 783F CD8E 58BC AFBA.
ZLIB_VERSION=1.3.2
ZLIB_SHA256=bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16
ZLIB_URL="https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz"
