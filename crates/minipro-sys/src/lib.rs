//! FFI bindings to upstream minipro's library (`libminipro`).
//!
//! **Placeholder for Phase 0.** burnwright drives minipro via its CLI for now
//! (see the `engine` crate). Phase 1 replaces that with direct FFI generated
//! here via `bindgen` + `cc`, kept behind the `engine::Engine` trait so the
//! swap is invisible to the rest of the app.
//!
//! Before building this out, confirm upstream actually exposes a linkable
//! library + stable headers — tracked in
//! <https://github.com/IamMrCupp/burnwright/issues/14>.

// Intentionally empty until Phase 1.
