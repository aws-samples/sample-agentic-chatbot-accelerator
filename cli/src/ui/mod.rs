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

/// Tell the user what is happening, on stderr.
///
/// stderr rather than stdout because stdout is the transcript: a progress line in
/// it would corrupt `aca chat -m … > out.txt`. These exist because the startup
/// path spends seconds on Cognito round trips with nothing on screen, which
/// reads as a hang — the TUI's own connecting screen only covers the last step.
fn progress(message: &str) {
    eprintln!("aca: {message}");
}

/// Everything [`dispatch`] needs from a signed-in user, however it was obtained.
type Authenticated = (
    String,
    crate::auth::Tokens,
    crate::auth::Identity,
    Option<String>,
);

/// Turn a saved session into usable tokens, refreshing only if it has to.
///
/// Two paths, and which one runs is the difference between an instant launch and
/// a fast one: an ID token with comfortable life left is used verbatim (**no**
/// Cognito call at all), otherwise the refresh token buys a new one in a single
/// `REFRESH_TOKEN_AUTH` round trip. Either way no password is asked for.
///
/// The identity is read back out of the ID token rather than stored, because it
/// is derived data — persisting `sub` alongside the token it comes from would let
/// the two disagree after a refresh.
async fn resume(
    config: &crate::config::AppConfig,
    session: crate::auth::store::Session,
) -> Result<Authenticated, crate::auth::LoginError> {
    let identity_id = session.identity_id.clone();
    let email = session.email.clone();

    if let Some(id_token) = session.fresh_id_token.clone() {
        let identity = crate::auth::identity_from_id_token(id_token.expose())?;
        let expires_at = session.id_token_expires_at;
        return Ok((
            email,
            session.into_tokens(id_token, expires_at),
            identity,
            identity_id,
        ));
    }

    progress("renewing your saved session...");
    let refreshed = crate::auth::refresh_id_token(config, session.refresh_token.expose()).await?;
    let identity = crate::auth::identity_from_id_token(refreshed.0.expose())?;
    let (id_token, expires_at) = refreshed;
    Ok((
        email,
        session.into_tokens(id_token, expires_at),
        identity,
        identity_id,
    ))
}

/// Log how long the step ending now took, and return the mark for the next one.
///
/// To the log file only, never the terminal: this is for answering "which of
/// these round trips is the slow one" on a real deployment, which is not a
/// question that can be settled offline — the local setup costs measure in
/// microseconds, so anything worth optimising is latency this build cannot see.
fn timed(since: std::time::Instant, step: &str) -> std::time::Instant {
    tracing::info!(
        step,
        elapsed_ms = since.elapsed().as_millis(),
        "startup step"
    );
    std::time::Instant::now()
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
        // Nothing to resolve, nothing to authenticate: this only deletes a file.
        Some(Command::Logout) => {
            crate::auth::store::forget();
            progress("signed out — the next run will ask for your password");
            return Ok(ExitCode::SUCCESS);
        }
    };

    let config = crate::config::resolve(&cli.config)
        .await
        .map_err(|err| Failure::new(exit::CONFIG, err))?;

    // Checked before the password prompt, not after: `--runtime-id` without
    // `--qualifier` is unusable no matter what the user types next, and making
    // them authenticate first only to be told they mistyped the invocation
    // wastes the one step they cannot script.
    let explicit = crate::discovery::explicit_target(&chat)
        .map_err(|err| Failure::new(discovery_exit_code(&err), err))?;

    let session_id = match &chat.session_id {
        Some(raw) => crate::protocol::SessionId::parse(raw.as_str())
            .map_err(|err| Failure::new(exit::USAGE, err))?,
        None => crate::protocol::SessionId::new_random(),
    };

    // A saved session is what makes a relaunch instant. Checked before anything
    // is prompted for, because the whole point is to ask for nothing.
    let saved = if cli.config.fresh_login {
        None
    } else {
        crate::auth::store::load(&config, chat.email.as_deref(), std::time::SystemTime::now())
    };

    let started = std::time::Instant::now();
    // A saved session that turns out to be dead must not be fatal. Cognito
    // answers a revoked refresh token and a wrong password with the same
    // `NotAuthorizedException`, so reporting it would tell someone who typed
    // nothing that their password was wrong. Forget it and ask instead.
    let resumed = match saved {
        None => None,
        Some(session) => {
            progress(&format!("using your saved session ({})", session.email));
            match resume(&config, session).await {
                Ok(authenticated) => Some(authenticated),
                Err(err) => {
                    tracing::warn!("saved session unusable ({err}); asking for a password");
                    progress("your saved session has expired — signing in again");
                    crate::auth::store::forget();
                    None
                }
            }
        }
    };

    let (email, tokens, identity, cached_identity_id) = match resumed {
        Some(authenticated) => authenticated,
        None => {
            let email = match &chat.email {
                Some(email) => email.clone(),
                None => {
                    plain::prompt_line("Email: ").map_err(|err| Failure::new(exit::AUTH, err))?
                }
            };
            let password = plain::read_password(chat.password_stdin)
                .map_err(|err| Failure::new(exit::AUTH, err))?;

            progress("signing in...");
            let prompt = plain::TerminalPasswordPrompt;
            let (tokens, identity) = crate::auth::login(&config, &email, password, &prompt)
                .await
                .map_err(|err| Failure::new(exit::AUTH, err))?;
            (email, tokens, identity, None)
        }
    };
    // Timed from here on, to the log only. A wall-clock total that included the
    // password prompt would say nothing about what is worth optimising.
    let after_login = timed(started, "authentication");

    // `aca agents` reads AppSync with the ID token and nothing else, so it stops
    // here: the identity-pool exchange below is two round trips it would never
    // use, and the credentials it produces are only needed to sign a WebSocket.
    if listing_only {
        let appsync_url = config.appsync_url.as_deref().ok_or_else(|| {
            Failure::new(exit::CONFIG, crate::discovery::DiscoveryError::NoEndpoint)
        })?;
        progress("fetching agents...");
        let agents = crate::discovery::list_runtime_agents(appsync_url, &tokens.id_token)
            .await
            .map_err(|err| Failure::new(discovery_exit_code(&err), err))?;
        timed(after_login, "list_runtime_agents");
        // Saved here too, or `aca agents` would prompt for a password every time
        // and never leave a session behind for `aca chat` to reuse. No identity
        // id to record: this path deliberately never ran the exchange.
        if !cli.config.fresh_login {
            crate::auth::store::save(
                &config,
                &email,
                &tokens,
                cached_identity_id.as_deref(),
                std::time::SystemTime::now(),
            );
        }
        // stdout, because this is the command's output rather than a diagnostic —
        // `aca agents | grep` has to work.
        print!("{}", crate::discovery::render_listing(&agents));
        return Ok(ExitCode::SUCCESS);
    }

    // Concurrent, not sequential: the identity-pool exchange and the agent
    // listing both need only the ID token login just returned, and neither
    // feeds the other. Run back to back they cost a round trip for nothing —
    // and this is latency the user is sitting through, having just typed a
    // password. The token is seconds old, so it cannot need the refresh the
    // broker would otherwise have been asked for.
    progress("fetching credentials and agents...");
    let id_token = tokens.id_token.clone();
    let expires_at = tokens.expires_at;
    let refresh_token = tokens.refresh_token.clone();
    let (broker, listing) = tokio::join!(
        crate::auth::CredentialBroker::new(&config, tokens, cached_identity_id),
        crate::discovery::listing_for(&config, &chat, &id_token),
    );
    // Auth first when both fail: a bad login explains a failed listing, and
    // reporting the listing error would send the user after the wrong problem.
    let broker = broker.map_err(|err| Failure::new(exit::AUTH, err))?;
    let listing = listing.map_err(|err| Failure::new(discovery_exit_code(&err), err))?;

    // Saved only once the exchange has *worked*, so a session file never claims
    // an identity id the pool rejects. Written on every run, which is what keeps
    // the 24h window rolling for someone who uses the CLI daily.
    if !cli.config.fresh_login {
        crate::auth::store::save(
            &config,
            &email,
            &crate::auth::Tokens {
                id_token: id_token.clone(),
                access_token: crate::telemetry::Secret::new(String::new()),
                refresh_token,
                expires_at,
            },
            Some(broker.identity_id()),
            std::time::SystemTime::now(),
        );
    }
    // One span for both, because they overlap: timing them separately would
    // report two numbers that cannot be added up.
    timed(after_login, "identity exchange and listing (concurrent)");

    // Config, credentials and identity move into the manager and stay there for
    // the whole run: `/session` and `/agent` need every one of them again, and a
    // sink that had only a socket could not honour either.
    let mut manager = crate::session::SessionManager::new(config, broker, identity);

    // Prompting happens here rather than inside the fetch above, so a question
    // the user has to answer is never asked while a request is still in flight.
    let target = match explicit {
        Some(target) => target,
        None => crate::discovery::select_target(
            &listing.unwrap_or_default(),
            chat.qualifier.as_deref(),
            &crate::discovery::TerminalChooser,
        )
        .map_err(|err| Failure::new(discovery_exit_code(&err), err))?,
    };

    // Chosen before connecting, not after: the TUI needs the terminal
    // initialised *before* it dials, so it can show a connecting screen for
    // the first cold start rather than leaving a blank terminal for up to a
    // minute with nothing on screen to say why.
    match select_sink(chat.plain, chat.message.is_some()) {
        SinkKind::Plain => {
            // Plain mode has no spinner to draw, but silence for up to a
            // minute reads as a hang — one line said once is enough.
            eprintln!(
                "aca: connecting to {} / {}...",
                target.agent_runtime_id, target.qualifier
            );
            let session = manager
                .open_with(target, session_id)
                .await
                .map_err(|err| Failure::new(session_exit_code(&err), err))?;
            Ok(plain::run(session, &mut manager, chat.message).await)
        }
        // The TUI owns the terminal, so its own failures cannot be printed
        // until it has restored it — which `tui::run` does before returning
        // either way.
        SinkKind::Tui => match tui::run(target, session_id, Box::new(manager)).await {
            Ok(code) => Ok(code),
            // The first connect never succeeded: the same precise mapping the
            // plain-mode `open_with` above would have gotten.
            Err(tui::RunError::Connect(err)) => Err(Failure::new(session_exit_code(&err), err)),
            Err(tui::RunError::Terminal(err)) => Err(Failure::new(exit::TRANSPORT, err)),
        },
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
