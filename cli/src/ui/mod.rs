//! Sink selection and top-level orchestration.
//!
//! Both sinks consume the one `mpsc<AgentEvent>` channel `transport` owns, so
//! adding the TUI (T11) is a matter of writing another consumer rather than
//! reworking anything below this layer.

pub mod plain;
pub mod tui;

use std::io::IsTerminal;
use std::process::ExitCode;

use crate::args::{ChatArgs, Cli, Command};

/// Which renderer to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkKind {
    Tui,
    Plain,
}

/// Exit codes, kept distinct so a script can tell *why* a run failed.
///
/// `1` is deliberately reserved for "the agent reported an error" so that
/// infrastructure problems (auth, connect) do not look like agent problems.
pub mod exit {
    /// The agent or service reported an error that ended the run.
    pub const AGENT_ERROR: u8 = 1;
    /// Configuration could not be resolved.
    pub const CONFIG: u8 = 2;
    /// Authentication failed.
    pub const AUTH: u8 = 3;
    /// The WebSocket could not be established, or died mid-run.
    pub const TRANSPORT: u8 = 4;
    /// The invocation itself was wrong (e.g. no runtime id and no discovery).
    pub const USAGE: u8 = 5;
}

/// Choose a sink.
///
/// Plain wins when `--plain` or `--message` is given, **or** when stdout is not a
/// TTY: a ratatui alternate-screen app emits escape sequences that would make
/// `aca chat … > out.txt` useless, and a user redirecting output has already told
/// us they want text.
pub fn select_sink(explicit_plain: bool, one_shot: bool) -> SinkKind {
    if explicit_plain || one_shot || !std::io::stdout().is_terminal() {
        SinkKind::Plain
    } else {
        SinkKind::Tui
    }
}

/// Top-level orchestration, called from `main`.
///
/// Order matters and mirrors the dependency chain: config (T4) → login (T7) →
/// credentials (T8) → agent selection → connect (T9) → sink. The crypto provider
/// (T1) and telemetry (T3) are already up by the time this runs, because a log
/// line or a TLS handshake here would otherwise be the first use of either.
///
/// Every error is rendered through its own typed `Display` rather than `anyhow`'s
/// debug chain, so the user sees the one actionable sentence the error type was
/// written to produce.
pub async fn run_cli(cli: Cli) -> ExitCode {
    match dispatch(cli).await {
        Ok(code) => code,
        Err(failure) => {
            // stderr, not stdout: stdout is the transcript, and a failure message
            // in it would corrupt a redirected run.
            eprintln!("aca: {}", failure.message);
            tracing::error!(code = failure.code, "{}", failure.message);
            ExitCode::from(failure.code)
        }
    }
}

/// A user-facing failure: one actionable sentence plus a scriptable code.
struct Failure {
    code: u8,
    message: String,
}

impl Failure {
    fn new(code: u8, message: impl std::fmt::Display) -> Self {
        Self {
            code,
            message: message.to_string(),
        }
    }
}

async fn dispatch(cli: Cli) -> Result<ExitCode, Failure> {
    let chat = match cli.command {
        // No subcommand means chat — the overwhelmingly common case, so it should
        // not need naming.
        None => ChatArgs::default(),
        Some(Command::Chat(args)) => args,
        Some(Command::Agents) => {
            return Err(Failure::new(
                exit::USAGE,
                "listing agents needs AppSync discovery, which is not built yet (T12); \
                 pass --runtime-id to chat with a known runtime",
            ));
        }
    };

    let config = crate::config::resolve(&cli.config)
        .await
        .map_err(|err| Failure::new(exit::CONFIG, err))?;

    // Required until T12 can look one up. Named explicitly so the message tells
    // the user what to do rather than reporting a missing field.
    let (runtime_id, qualifier) = match (&chat.runtime_id, &chat.qualifier) {
        (Some(runtime_id), Some(qualifier)) => (runtime_id.clone(), qualifier.clone()),
        (Some(_), None) => {
            return Err(Failure::new(
                exit::USAGE,
                "--qualifier is required with --runtime-id until agent discovery lands (T12); \
                 try --qualifier DEFAULT",
            ));
        }
        (None, _) => {
            return Err(Failure::new(
                exit::USAGE,
                "no agent selected: pass --runtime-id (and --qualifier); \
                 automatic discovery lands in T12",
            ));
        }
    };

    let session_id = match &chat.session_id {
        Some(raw) => crate::protocol::SessionId::parse(raw.as_str())
            .map_err(|err| Failure::new(exit::USAGE, err))?,
        None => crate::protocol::SessionId::new_random(),
    };

    let email = match &chat.email {
        Some(email) => email.clone(),
        None => plain::prompt_line("Email: ").map_err(|err| Failure::new(exit::AUTH, err))?,
    };
    let password =
        plain::read_password(chat.password_stdin).map_err(|err| Failure::new(exit::AUTH, err))?;

    let prompt = plain::TerminalPasswordPrompt;
    let (tokens, identity) = crate::auth::login(&config, &email, password, &prompt)
        .await
        .map_err(|err| Failure::new(exit::AUTH, err))?;

    let mut broker = crate::auth::CredentialBroker::new(&config, tokens)
        .await
        .map_err(|err| Failure::new(exit::AUTH, err))?;

    let connection = crate::transport::connect(
        crate::transport::ConnectParams {
            config: &config,
            agent_runtime_id: &runtime_id,
            qualifier: &qualifier,
            // Empty until T12 can resolve it from the agent's
            // `qualifierToVersion`. The browser sends "" the same way when it
            // cannot resolve a version, and the container's DynamoDB write uses
            // `if_not_exists`, so an empty value is skipped rather than stored.
            runtime_version: "",
            session_id: &session_id,
            identity: &identity,
        },
        &mut broker,
    )
    .await
    .map_err(|err| Failure::new(exit::TRANSPORT, err))?;

    match select_sink(chat.plain, chat.message.is_some()) {
        SinkKind::Plain => Ok(plain::run(connection, chat.message).await),
        // The TUI owns the terminal, so its own failures cannot be printed until
        // it has restored it — which `tui::run` does before returning either way.
        SinkKind::Tui => tui::run(connection)
            .await
            .map_err(|err| Failure::new(exit::TRANSPORT, err)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_flags_force_plain() {
        assert_eq!(select_sink(true, false), SinkKind::Plain);
        assert_eq!(select_sink(false, true), SinkKind::Plain);
    }

    #[test]
    fn a_redirected_stdout_selects_plain_without_the_flag() {
        // Under `cargo test` stdout is captured, not a terminal, which is exactly
        // the redirect case: `aca chat … > out.txt` must not emit escape
        // sequences, so this asserts the auto-detection rather than the flag.
        assert!(!std::io::stdout().is_terminal());
        assert_eq!(select_sink(false, false), SinkKind::Plain);
    }

    #[test]
    fn exit_codes_are_distinct() {
        // They are scriptable, so a collision would silently conflate two very
        // different failures.
        let codes = [
            exit::AGENT_ERROR,
            exit::CONFIG,
            exit::AUTH,
            exit::TRANSPORT,
            exit::USAGE,
        ];
        let unique: std::collections::HashSet<_> = codes.iter().collect();
        assert_eq!(unique.len(), codes.len());
        assert!(!codes.contains(&0), "0 must stay reserved for success");
    }
}
