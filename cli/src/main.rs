//! `aca` — thin entry point. Everything substantive lives in the library so it
//! is reachable from integration tests; see `lib.rs` for why.

use aca_cli::{args, telemetry, tls};
use clap::Parser;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tls::install_crypto_provider()?;

    // Args first so `--help` and `--version` exit without touching the network
    // *or* creating the log directory. Nothing between here and telemetry init
    // logs, so the ordering costs no coverage.
    let cli = args::Cli::parse();

    // Bound to a named local, not bare `_`: `_log_guard` lives to the end of
    // `main`, whereas `_` would drop at once and discard every buffered line.
    let _log_guard = telemetry::init(None)?;
    // No-op `restore` until T11 owns the alternate screen and has something to
    // tear down; installed now so the hook itself is never forgotten later.
    telemetry::install_panic_hook(|| {});
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "aca starting");

    // Printing is the whole behaviour for now: the flags are a settled contract
    // (T2), everything behind them lands in later tasks.
    println!("{cli:#?}");

    Ok(())
}
