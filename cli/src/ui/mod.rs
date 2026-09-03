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
use crate::session::SessionControl;

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

/// The CLI's own commands, typed into the chat rather than passed as flags.
///
/// A leading `/` is the only marker. Both sinks parse the same list, so a command
/// cannot exist in the TUI and silently reach the agent as literal text in plain
/// mode — which is the drift this shared function exists to prevent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Submission {
    /// Send this to the agent.
    Turn(String),
    /// Leave.
    Quit,
    /// Start a new session with the same agent.
    NewSession,
    /// Choose a different agent, in a new session.
    ChooseAgent,
    /// List the commands.
    Help,
    /// A `/word` that is not a command. Reported rather than sent: an agent
    /// gamely answering a question about a command it has never heard of is a
    /// worse outcome than being told the name was mistyped.
    Unknown(String),
}

/// The command list, single-sourced so `/help` and the README cannot disagree.
pub const COMMANDS: &[(&str, &str)] = &[
    (
        "/session",
        "start a new session with the same agent (the agent forgets the conversation)",
    ),
    ("/agent", "switch to another agent, in a new session"),
    ("/help", "show this list"),
    ("/quit", "leave the chat (ctrl-c also works)"),
];

/// Classify a submitted line.
///
/// Only a line whose **first** character is `/` can be a command, and only its
/// first word is examined: `/tmp/foo is missing` is a question about a path, so
/// anything unrecognised is reported as a typo rather than guessed at.
pub fn parse_submission(text: &str) -> Submission {
    let Some(rest) = text.strip_prefix('/') else {
        return Submission::Turn(text.to_string());
    };
    match rest.split_whitespace().next().unwrap_or_default() {
        // A bare `/` is someone reaching for the command list.
        "" | "help" | "?" | "commands" => Submission::Help,
        "quit" | "exit" | "q" => Submission::Quit,
        // `new` because that is what the web UI's button says.
        "session" | "new" => Submission::NewSession,
        "agent" | "agents" | "switch" => Submission::ChooseAgent,
        other => Submission::Unknown(format!("/{other}")),
    }
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

    let broker = crate::auth::CredentialBroker::new(&config, tokens)
        .await
        .map_err(|err| Failure::new(exit::AUTH, err))?;

    // Config, credentials and identity move into the manager and stay there for
    // the whole run: `/session` and `/agent` need every one of them again, and a
    // sink that had only a socket could not honour either.
    let mut manager = crate::session::SessionManager::new(config, broker, identity);

    if listing_only {
        // stdout, because this is the command's output rather than a diagnostic —
        // `aca agents | grep` has to work.
        let agents = manager
            .agents()
            .await
            .map_err(|err| Failure::new(session_exit_code(&err), err))?;
        print!("{}", crate::discovery::render_listing(&agents));
        return Ok(ExitCode::SUCCESS);
    }

    let target = manager
        .resolve(&chat, &crate::discovery::TerminalChooser)
        .await
        .map_err(|err| Failure::new(session_exit_code(&err), err))?;

    let session = manager
        .open_with(target, session_id)
        .await
        .map_err(|err| Failure::new(session_exit_code(&err), err))?;

    match select_sink(chat.plain, chat.message.is_some()) {
        SinkKind::Plain => Ok(plain::run(session, &mut manager, chat.message).await),
        // The TUI owns the terminal, so its own failures cannot be printed until
        // it has restored it — which `tui::run` does before returning either way.
        SinkKind::Tui => tui::run(session, Box::new(manager))
            .await
            .map_err(|err| Failure::new(exit::TRANSPORT, err)),
    }
}

/// Map a session failure onto the right scriptable code.
///
/// Delegates the discovery half rather than collapsing it: a `/agent` that fails
/// because nothing is deployed is a different situation from one that fails
/// because AppSync is unreachable, and the exit code is the only thing a script
/// can see.
fn session_exit_code(error: &crate::session::SessionError) -> u8 {
    use crate::session::SessionError as E;

    match error {
        E::Transport(_) => exit::TRANSPORT,
        E::Discovery(discovery) => discovery_exit_code(discovery),
        E::Credentials(_) => exit::AUTH,
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
    fn the_commands_and_their_aliases_parse() {
        for (text, expected) in [
            ("/session", Submission::NewSession),
            ("/new", Submission::NewSession),
            ("/agent", Submission::ChooseAgent),
            ("/agents", Submission::ChooseAgent),
            ("/switch", Submission::ChooseAgent),
            ("/quit", Submission::Quit),
            ("/exit", Submission::Quit),
            ("/q", Submission::Quit),
            ("/help", Submission::Help),
            ("/?", Submission::Help),
            ("/", Submission::Help),
        ] {
            assert_eq!(parse_submission(text), expected, "{text}");
        }
    }

    #[test]
    fn ordinary_text_is_never_mistaken_for_a_command() {
        for text in [
            "what is the weather in Rome?",
            // The slash is not leading, so this is a question about a path.
            "does /etc/hosts exist?",
            "summarise this: /session was a typo",
        ] {
            assert_eq!(
                parse_submission(text),
                Submission::Turn(text.to_string()),
                "{text}"
            );
        }
    }

    #[test]
    fn a_command_may_carry_arguments_it_does_not_use_yet() {
        // `/session please` should still start a session rather than being sent
        // to the agent: only the first word decides.
        assert_eq!(parse_submission("/session please"), Submission::NewSession);
    }

    #[test]
    fn an_unrecognised_command_is_reported_not_sent_to_the_agent() {
        // A realistic misspelling cannot be used as the fixture here: the repo's
        // `typos` pre-commit hook rewrites one into the correctly spelled command,
        // which would quietly invert this assertion.
        assert_eq!(
            parse_submission("/frobnicate"),
            Submission::Unknown("/frobnicate".to_string())
        );
    }

    #[test]
    fn every_documented_command_is_one_the_parser_accepts() {
        // `/help` prints this table, so an entry the parser does not know would
        // advertise a command that does nothing.
        for (name, _) in COMMANDS {
            assert!(
                !matches!(parse_submission(name), Submission::Unknown(_)),
                "{name} is documented but unparsed"
            );
        }
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
