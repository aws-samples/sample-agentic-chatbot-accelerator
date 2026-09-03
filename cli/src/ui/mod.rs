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

/// Run `aca agents`: list what is deployed and exit.
///
/// The listing goes to **stdout** because it is this command's output, not a
/// diagnostic — `aca agents | grep` has to work.
async fn list_agents(
    config: &crate::config::AppConfig,
    broker: &mut crate::auth::CredentialBroker,
) -> Result<ExitCode, Failure> {
    let appsync_url = config
        .appsync_url
        .as_deref()
        .ok_or_else(|| Failure::new(exit::CONFIG, crate::discovery::DiscoveryError::NoEndpoint))?;
    let id_token = broker
        .id_token()
        .await
        .map_err(|err| Failure::new(exit::AUTH, err))?;

    let agents = crate::discovery::list_runtime_agents(appsync_url, &id_token)
        .await
        .map_err(|err| Failure::new(discovery_exit_code(&err), err))?;

    print!("{}", crate::discovery::render_listing(&agents));
    Ok(ExitCode::SUCCESS)
}

/// Map a discovery failure onto the right scriptable code.
///
/// Discovery can fail for reasons in three different categories, and collapsing
/// them onto one code would tell a script "could not pick an agent" without
/// saying whether to fix the invocation, the deployment, or the network.
fn discovery_exit_code(error: &crate::discovery::DiscoveryError) -> u8 {
    use crate::discovery::DiscoveryError as E;

    match error {
        // The deployment is reachable but has nothing to offer, or the
        // invocation named something that does not exist: the user acts next.
        E::QualifierRequired
        | E::NoAgents
        | E::NoQualifiers(_)
        | E::UnknownQualifier { .. }
        | E::Unselectable(_) => exit::USAGE,
        // No endpoint configured is a configuration hole, same as a missing region.
        E::NoEndpoint => exit::CONFIG,
        E::Credentials(_) => exit::AUTH,
        // A GraphQL authorisation error also lands here. It is reported as a
        // transport failure rather than an auth one because the login itself
        // succeeded — what failed is one request against AppSync.
        E::Http(_) | E::GraphQl(_) => exit::TRANSPORT,
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
    // `agents` needs the same config and login as `chat`, so the two paths share
    // everything up to the point where one lists and the other connects.
    let (chat, listing_only) = match cli.command {
        // No subcommand means chat — the overwhelmingly common case, so it should
        // not need naming.
        None => (ChatArgs::default(), false),
        Some(Command::Chat(args)) => (args, false),
        Some(Command::Agents(args)) => (
            ChatArgs {
                email: args.email,
                password_stdin: args.password_stdin,
                ..Default::default()
            },
            true,
        ),
    };

    let config = crate::config::resolve(&cli.config)
        .await
        .map_err(|err| Failure::new(exit::CONFIG, err))?;

    // Checked before the password prompt, not after: `--runtime-id` without
    // `--qualifier` is unusable no matter what the user types next, and making
    // them authenticate first only to be told they mistyped the invocation
    // wastes the one step they cannot script.
    if !listing_only {
        crate::discovery::explicit_target(&chat)
            .map_err(|err| Failure::new(discovery_exit_code(&err), err))?;
    }

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

    if listing_only {
        return list_agents(&config, &mut broker).await;
    }

    let target = crate::discovery::resolve_target(
        &config,
        &chat,
        &mut broker,
        &crate::discovery::TerminalChooser,
    )
    .await
    .map_err(|err| Failure::new(discovery_exit_code(&err), err))?;

    let connection = crate::transport::connect(
        crate::transport::ConnectParams {
            config: &config,
            agent_runtime_id: &target.agent_runtime_id,
            qualifier: &target.qualifier,
            // Resolved from the agent's `qualifierToVersion` when discovery ran,
            // and empty in the `--runtime-id` path where no summary was fetched.
            // The container's session write uses `if_not_exists`, so an empty
            // value is skipped rather than stored as a blank — the same thing the
            // browser sends when it cannot resolve one.
            runtime_version: &target.runtime_version,
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
