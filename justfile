# burnwright task runner — https://just.systems  (run `just` to list recipes)

# List available recipes
default:
    @just --list

# Install JS dependencies
install:
    pnpm install

# Run the app in dev mode (Vite + Tauri)
dev:
    pnpm tauri dev

# Build the vendored upstream minipro CLI (needs libusb + pkg-config).
# macOS: brew install libusb pkg-config   Debian/Ubuntu: apt install libusb-1.0-0-dev pkg-config
build-minipro:
    make -C vendor/minipro

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
