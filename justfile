# burnwright task runner — https://just.systems  (run `just` to list recipes)

# List available recipes
default:
    @just --list

# Install JS dependencies
install:
    pnpm install

# Run the app in dev mode (Vite + Tauri). Needs the sidecar: `just sidecar`.
dev:
    pnpm tauri dev

# Build the minipro sidecar for this machine (see docs/minipro-sidecar.md).
# macOS: brew install pkgconf   Debian/Ubuntu: apt install build-essential pkg-config zlib1g-dev
sidecar:
    scripts/minipro/build-sidecar.sh

# Run Rust and frontend tests
test:
    cargo test --workspace
    pnpm test

# Format + lint + typecheck gates (mirrors CI)
check:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings
    pnpm exec tsc --noEmit
    pnpm lint

# Produce installable bundles for the current OS
bundle:
    pnpm tauri build

# Initialise / update the vendored minipro submodule
vendor-update:
    git submodule update --init --recursive
