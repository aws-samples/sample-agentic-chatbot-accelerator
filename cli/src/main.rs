//! `aca` — thin entry point. Everything substantive lives in the library so it
//! is reachable from integration tests; see `lib.rs` for why.

use std::process::ExitCode;

use aca_cli::{args, telemetry, tls, ui};
use clap::Parser;

#[tokio::main]
async fn main() -> ExitCode {
    // First, before any TLS use: two crates in the graph depend on rustls without
    // selecting a provider, and the wrong outcome is an opaque panic at first
    // connect rather than a compile error.
    if let Err(err) = tls::install_crypto_provider() {
        eprintln!("aca: {err}");
        return ExitCode::FAILURE;
    }

    // Args before telemetry so `--help` and `--version` exit without touching the
    // network *or* creating the log directory. Nothing in between logs.
    let cli = args::Cli::parse();

    // Bound to a named local, not bare `_`: `_log_guard` lives to the end of
    // `main`, whereas `_` would drop at once and discard every buffered line.
    let _log_guard = match telemetry::init(None) {
        Ok(guard) => guard,
        Err(err) => {
            eprintln!("aca: could not start logging: {err}");
            return ExitCode::FAILURE;
        }
    };
    // No-op `restore` until T11 owns the alternate screen and has something to
    // tear down; installed now so the hook itself is never forgotten later.
    telemetry::install_panic_hook(|| {});
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "aca starting");

    // `run_cli` renders its own errors through their typed `Display` and returns a
    // scriptable code, so `main` deliberately does not use `anyhow`'s `Termination`
    // impl — that would print a debug chain instead of the actionable sentence.
    ui::run_cli(cli).await
}
