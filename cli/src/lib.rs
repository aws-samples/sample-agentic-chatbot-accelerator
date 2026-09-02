//! Terminal client for chatting with a deployed AgentCore agent.
//!
//! The crate is split into a library plus a thin `aca` binary for two reasons
//! the task plan depends on:
//!
//! - **Integration tests need a library target.** T4 and T6 both load golden
//!   fixtures from `cli/tests/fixtures/`, which only a `tests/*.rs` target can
//!   reach, and those can only `use` a lib.
//! - **`pub` items in a `bin` are still dead code.** Most modules here are not
//!   wired into `main` until T10, so under `-D warnings` every one of them would
//!   need a `dead_code` exemption. In a lib they are public API instead.
//!
//! Module bands, per the design doc: `protocol` and `presign` are **pure** and
//! carry the whole opaque-failure surface (a bad presign is a bare 403, a
//! too-short session id is an indistinguishable 400), so both are testable
//! offline. `config`, `auth`, `transport` and `discovery` do IO. `telemetry` is a
//! leaf everything depends on, so no module can accidentally log to stdout.

pub mod args;
pub mod auth;
pub mod config;
pub mod presign;
pub mod protocol;
pub mod telemetry;
pub mod tls;
