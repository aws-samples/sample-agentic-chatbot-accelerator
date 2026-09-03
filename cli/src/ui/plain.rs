//! Line-mode sink: a linear, greppable transcript.
//!
//! Plain mode ships before the TUI on purpose. During bring-up a 403, a malformed
//! frame or a panic behind ratatui's alternate screen destroys exactly the
//! diagnostic needed to tell them apart, so chat is proven on a sink whose output
//! survives being redirected to a file.

use std::io::{IsTerminal, Write};
use std::process::ExitCode;

use tokio::sync::mpsc::Receiver;

use crate::protocol::AgentEvent;
use crate::session::{Session, SessionControl};
use crate::telemetry::Secret;
use crate::transport::AgentConnection;

use super::{Submission, parse_submission};

/// How a single turn ended.
#[derive(Debug, PartialEq, Eq)]
enum TurnOutcome {
    /// A `final_response` arrived; the turn is complete.
    Complete,
    /// The server reported an application error.
    ServerError(String),
    /// The channel closed without a `final_response` — the socket went away.
    Disconnected,
}

/// Run the line-mode chat loop.
///
/// Reads prompts from stdin, or sends `one_shot` and returns. Reuses **one**
/// connection across turns: same session id, one socket. Reconnecting per turn
/// would trigger the 409 retry path for no reason and lose the conversation
/// context the second-prompt acceptance check depends on.
///
/// `manager` is here only for `/session` and `/agent`. The commands are supported
/// in this sink as well as the TUI because the alternative is worse than not
/// having them: a user who types `/session` at a plain prompt would otherwise
/// have it sent to the agent as a question.
pub async fn run(
    session: Session,
    manager: &mut dyn SessionControl,
    one_shot: Option<String>,
) -> ExitCode {
    let Session {
        mut connection,
        mut target,
    } = session;
    let mut stdout = std::io::stdout();
    tracing::info!(
        session_id = connection.session_id().as_str(),
        "starting plain chat"
    );

    if let Some(text) = one_shot {
        let code = match send_and_render(&mut connection, &text, &mut stdout).await {
            Ok(outcome) => outcome_to_code(outcome, &mut std::io::stderr()),
            Err(code) => code,
        };
        // Best-effort: a failed close cannot change what already happened.
        let _ = connection.close().await;
        return code;
    }

    let interactive = std::io::stdin().is_terminal();

    loop {
        if interactive {
            // The prompt marker, so the user's own typing lands after it and the
            // transcript reads the same as the redirected form.
            let _ = write!(stdout, "> ");
            let _ = stdout.flush();
        }
        // Read a line at a time rather than holding a `StdinLock` for the whole
        // loop: `/agent` prompts through the same stdin, and a held lock would
        // deadlock the moment the picker asked a question.
        let mut line = String::new();
        match std::io::stdin().read_line(&mut line) {
            // EOF: a piped script ran out of input, which is a clean exit.
            Ok(0) => break,
            Ok(_) => {}
            Err(err) => {
                eprintln!("aca: could not read stdin: {err}");
                break;
            }
        }
        let text = line.trim().to_string();
        if text.is_empty() {
            continue;
        }

        let text = match parse_submission(&text) {
            Submission::Turn(text) => text,
            Submission::Quit => break,
            Submission::Help => {
                for (name, description) in super::COMMANDS {
                    // stderr: the commands are not part of the transcript, and a
                    // redirected run should not collect them.
                    eprintln!("  {name:<10} {description}");
                }
                continue;
            }
            Submission::Unknown(name) => {
                eprintln!("aca: {name} is not a command — /help lists them");
                continue;
            }
            command @ (Submission::NewSession | Submission::ChooseAgent) => {
                let switching = command == Submission::ChooseAgent;
                match reconnect(manager, &target, switching).await {
                    Ok(session) => {
                        let previous = std::mem::replace(&mut connection, session.connection);
                        let _ = previous.close().await;
                        target = session.target;
                        // The agent has none of the conversation above, and in a
                        // linear transcript that boundary is otherwise invisible.
                        let _ = writeln!(
                            stdout,
                            "-- new session on {} / {} (the agent does not have the conversation above) --",
                            target.agent_runtime_id, target.qualifier
                        );
                        let _ = stdout.flush();
                    }
                    Err(err) => eprintln!("aca: {err}"),
                }
                continue;
            }
        };

        if !interactive {
            // Echo, so a piped transcript shows what was asked. Skipped when
            // interactive because the terminal already echoed it.
            let _ = writeln!(stdout, "> {text}");
        }

        match send_and_render(&mut connection, &text, &mut stdout).await {
            Ok(TurnOutcome::Complete) => continue,
            Ok(outcome) => {
                let code = outcome_to_code(outcome, &mut std::io::stderr());
                let _ = connection.close().await;
                return code;
            }
            Err(code) => {
                let _ = connection.close().await;
                return code;
            }
        }
    }

    let _ = connection.close().await;
    ExitCode::SUCCESS
}

/// Open a new session: the same agent, or one the user picks.
///
/// The picker is [`crate::discovery::TerminalChooser`], the same two-step prompt
/// the startup path uses — line mode has no overlay to draw, and reusing it means
/// the selection rules cannot differ between starting up and switching.
async fn reconnect(
    manager: &mut dyn SessionControl,
    current: &crate::discovery::Target,
    switching: bool,
) -> Result<Session, crate::session::SessionError> {
    let target = if switching {
        let agents = manager.agents().await?;
        crate::discovery::select_target(&agents, None, &crate::discovery::TerminalChooser)?
    } else {
        current.clone()
    };
    manager.open(target).await
}

/// Send one turn and render until it ends.
///
/// `Err` carries an exit code for a send failure, which is a transport problem
/// rather than anything the agent said.
async fn send_and_render(
    conn: &mut AgentConnection,
    text: &str,
    out: &mut impl Write,
) -> Result<TurnOutcome, ExitCode> {
    if let Err(err) = conn.send_text(text).await {
        eprintln!("aca: {err}");
        tracing::error!(error = %err, "send failed");
        return Err(ExitCode::from(super::exit::TRANSPORT));
    }
    Ok(render_turn(&mut conn.events, out).await)
}

/// Translate a turn outcome into a process exit code, explaining it on stderr.
fn outcome_to_code(outcome: TurnOutcome, errors: &mut impl Write) -> ExitCode {
    match outcome {
        TurnOutcome::Complete => ExitCode::SUCCESS,
        TurnOutcome::ServerError(message) => {
            let _ = writeln!(errors, "aca: the agent reported an error: {message}");
            ExitCode::from(super::exit::AGENT_ERROR)
        }
        TurnOutcome::Disconnected => {
            let _ = writeln!(
                errors,
                "aca: the connection closed before the reply completed"
            );
            ExitCode::from(super::exit::TRANSPORT)
        }
    }
}

/// Render events for one turn.
///
/// Takes the receiver rather than the whole connection so the transcript is
/// assertable from a synthetic channel, which is the only way to test the render
/// shape without a live runtime.
///
/// Output shape, stable enough to grep:
///
/// ```text
/// > what is the weather in Rome?
/// [tool: http_request]
/// [tool: http_request ok]
/// It is 24°C and sunny in Rome.
/// ```
async fn render_turn(events: &mut Receiver<AgentEvent>, out: &mut impl Write) -> TurnOutcome {
    // Tracks whether the current line has unterminated token text, so the newline
    // before a tool line or at end of turn is written exactly once.
    let mut mid_line = false;

    while let Some(event) = events.recv().await {
        match event {
            AgentEvent::TextToken { data, .. } => {
                let _ = write!(out, "{data}");
                // Flush per token, not per line. Without this, line-buffered
                // stdout holds partial lines and the reply arrives in chunks —
                // which would still pass a "tokens rendered" assertion while
                // failing the actual goal of *watching* the stream arrive.
                let _ = out.flush();
                mid_line = !data.ends_with('\n');
            }
            AgentEvent::ToolAction { tool_name, .. } => {
                if mid_line {
                    let _ = writeln!(out);
                    mid_line = false;
                }
                // Minimal on purpose: no spinner, no argument dump. T11 owns the
                // richer indicator, and building two independently-featured UIs is
                // how they drift.
                let _ = writeln!(out, "[tool: {tool_name}]");
                let _ = out.flush();
            }
            AgentEvent::ToolComplete {
                tool_name, status, ..
            } => {
                if mid_line {
                    let _ = writeln!(out);
                    mid_line = false;
                }
                let _ = writeln!(out, "[tool: {tool_name} {status}]");
                let _ = out.flush();
            }
            AgentEvent::FinalResponse(final_response) => {
                // The container streams the answer as tokens *and* repeats it
                // here. Printing the content again would duplicate the whole
                // reply, so it is only used when nothing streamed — which is what
                // a non-streaming architecture looks like.
                if !mid_line && final_response.content.is_empty() {
                    // Nothing streamed and nothing to show: leave the transcript
                    // alone rather than emitting a blank line.
                } else if !mid_line {
                    let _ = writeln!(out, "{}", final_response.content);
                } else {
                    let _ = writeln!(out);
                }
                let _ = out.flush();
                return TurnOutcome::Complete;
            }
            AgentEvent::ServerError { message } => {
                if mid_line {
                    let _ = writeln!(out);
                }
                let _ = out.flush();
                return TurnOutcome::ServerError(message);
            }
            AgentEvent::HeartbeatAck => continue,
            AgentEvent::Unknown { r#type } => {
                // To file, never to the transcript: raw JSON in the middle of a
                // reply is worse than silence, and the four architectures may emit
                // types this build does not know.
                tracing::debug!(event_type = %r#type, "ignoring unknown event type");
            }
        }
    }

    if mid_line {
        let _ = writeln!(out);
        let _ = out.flush();
    }
    TurnOutcome::Disconnected
}

/// Read one line from stdin with a prompt, for the email.
pub fn prompt_line(prompt: &str) -> anyhow::Result<String> {
    // stderr, so a redirected transcript does not begin with a prompt.
    eprint!("{prompt}");
    std::io::stderr().flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(line.trim().to_string())
}

/// Read the password: no-echo from the terminal, or a line from stdin.
///
/// Wrapped in [`Secret`] at the moment of creation so it can never be printed or
/// logged, and is zeroized when dropped.
pub fn read_password(from_stdin: bool) -> anyhow::Result<Secret<String>> {
    if from_stdin {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        Ok(Secret::new(line.trim_end_matches(['\n', '\r']).to_string()))
    } else {
        Ok(Secret::new(rpassword::prompt_password("Password: ")?))
    }
}

/// Prompts on the terminal when Cognito demands a replacement password.
///
/// Fires on essentially every first login, because all users are admin-created
/// and start in `FORCE_CHANGE_PASSWORD`. The prompt warns about the deadline: the
/// challenge session lapses after roughly three minutes, and a user who wanders
/// off gets a failure that reads nothing like "you were too slow".
pub struct TerminalPasswordPrompt;

impl crate::auth::NewPasswordPrompt for TerminalPasswordPrompt {
    fn request(
        &self,
        required_attributes: &[String],
    ) -> Result<(Secret<String>, std::collections::HashMap<String, String>), crate::auth::LoginError>
    {
        eprintln!(
            "This account needs a new password before first use. \
             Cognito allows about three minutes, so answer promptly."
        );
        let password = rpassword::prompt_password("New password: ")
            .map_err(|err| crate::auth::LoginError::Sdk(err.to_string()))?;

        let mut attributes = std::collections::HashMap::new();
        for name in required_attributes {
            let value = prompt_line(&format!("{name}: "))
                .map_err(|err| crate::auth::LoginError::Sdk(err.to_string()))?;
            attributes.insert(name.clone(), value);
        }
        Ok((Secret::new(password), attributes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{RuntimeSummary, Target};
    use crate::protocol::FinalResponse;
    use crate::session::SessionError;

    /// Records what it was asked for and hands back a recording connection.
    struct FakeControl {
        agents: Vec<RuntimeSummary>,
        opened: Vec<Target>,
        listings: usize,
    }

    impl SessionControl for FakeControl {
        fn open(
            &mut self,
            target: Target,
        ) -> std::pin::Pin<Box<dyn Future<Output = Result<Session, SessionError>> + Send + '_>>
        {
            self.opened.push(target.clone());
            Box::pin(async move {
                Ok(Session {
                    connection: crate::transport::test_connection().connection,
                    target,
                })
            })
        }

        fn open_with(
            &mut self,
            target: Target,
            _session_id: crate::protocol::SessionId,
        ) -> std::pin::Pin<Box<dyn Future<Output = Result<Session, SessionError>> + Send + '_>>
        {
            // Nothing here exercises this path today — the plain sink's initial
            // connect calls the inherent `SessionManager::open_with` directly,
            // before the manager is ever behind this trait. Stubbed only because
            // the trait requires it.
            self.opened.push(target.clone());
            Box::pin(async move {
                Ok(Session {
                    connection: crate::transport::test_connection().connection,
                    target,
                })
            })
        }

        fn agents(
            &mut self,
        ) -> std::pin::Pin<
            Box<dyn Future<Output = Result<Vec<RuntimeSummary>, SessionError>> + Send + '_>,
        > {
            self.listings += 1;
            let agents = self.agents.clone();
            Box::pin(async move { Ok(agents) })
        }
    }

    fn current() -> Target {
        Target {
            agent_runtime_id: "weather_agent-AbCdEf1234".to_string(),
            qualifier: "DEFAULT".to_string(),
            runtime_version: "3".to_string(),
        }
    }

    #[tokio::test]
    async fn a_new_session_reuses_the_current_agent_without_asking_appsync() {
        // `/session` means "same agent, new conversation". Listing agents here
        // would be a round-trip and a prompt for a choice already made.
        let mut manager = FakeControl {
            agents: Vec::new(),
            opened: Vec::new(),
            listings: 0,
        };
        let session = reconnect(&mut manager, &current(), false)
            .await
            .expect("reconnect");

        assert_eq!(session.target, current());
        assert_eq!(manager.opened, vec![current()]);
        assert_eq!(manager.listings, 0, "/session must not query AppSync");
    }

    #[tokio::test]
    async fn switching_agents_lists_and_opens_the_chosen_one() {
        // One agent with one endpoint, so the selection is silent and the test
        // does not depend on a terminal prompt.
        let mut manager = FakeControl {
            agents: vec![RuntimeSummary {
                agent_name: "research_swarm".to_string(),
                agent_runtime_id: "research_swarm-Zz9988".to_string(),
                qualifier_to_version: Some(r#"{"DEFAULT":"1"}"#.to_string()),
                status: Some("Ready".to_string()),
                architecture_type: Some("SWARM".to_string()),
            }],
            opened: Vec::new(),
            listings: 0,
        };
        let session = reconnect(&mut manager, &current(), true)
            .await
            .expect("reconnect");

        assert_eq!(manager.listings, 1);
        assert_eq!(
            session.target,
            Target {
                agent_runtime_id: "research_swarm-Zz9988".to_string(),
                qualifier: "DEFAULT".to_string(),
                // Resolved from the listing rather than left blank.
                runtime_version: "1".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn switching_with_nothing_deployed_fails_without_opening_anything() {
        let mut manager = FakeControl {
            agents: Vec::new(),
            opened: Vec::new(),
            listings: 0,
        };
        // `Session` holds a live socket and so has no `Debug`; matching keeps the
        // assertion without demanding one.
        let Err(err) = reconnect(&mut manager, &current(), true).await else {
            panic!("switching with nothing deployed must fail");
        };

        assert!(err.to_string().contains("no agents"), "{err}");
        assert!(manager.opened.is_empty(), "nothing may be dialled");
    }

    /// Build a receiver pre-loaded with `events`, as if a runtime had sent them.
    fn channel_of(events: Vec<AgentEvent>) -> Receiver<AgentEvent> {
        let (tx, rx) = tokio::sync::mpsc::channel(events.len().max(1));
        for event in events {
            tx.try_send(event).expect("test channel has room");
        }
        rx
    }

    fn token(data: &str) -> AgentEvent {
        AgentEvent::TextToken {
            data: data.to_string(),
            sequence_number: 0,
            run_id: None,
        }
    }

    fn final_response() -> AgentEvent {
        AgentEvent::FinalResponse(FinalResponse {
            content: "It is 24C and sunny in Rome.".to_string(),
            session_id: "s".to_string(),
            message_id: "m".to_string(),
            references: None,
            reasoning_content: None,
            structured_output: None,
        })
    }

    #[tokio::test]
    async fn renders_tokens_tool_lines_and_suppresses_unknown_events() {
        let mut events = channel_of(vec![
            AgentEvent::ToolAction {
                tool_name: "http_request".to_string(),
                description: None,
                invocation_number: 1,
                parameters: Vec::new(),
            },
            AgentEvent::ToolComplete {
                tool_name: "http_request".to_string(),
                invocation_number: 1,
                status: "ok".to_string(),
            },
            // Must leave no trace in the transcript: raw JSON mid-reply is worse
            // than silence.
            AgentEvent::Unknown {
                r#type: "bidi_audio".to_string(),
            },
            AgentEvent::HeartbeatAck,
            token("It is 24C "),
            token("and sunny in Rome."),
            final_response(),
        ]);

        let mut out = Vec::new();
        let outcome = render_turn(&mut events, &mut out).await;

        assert_eq!(outcome, TurnOutcome::Complete);
        assert_eq!(
            String::from_utf8(out).expect("utf-8"),
            "[tool: http_request]\n[tool: http_request ok]\nIt is 24C and sunny in Rome.\n"
        );
    }

    #[tokio::test]
    async fn a_tool_line_after_streamed_text_starts_on_its_own_line() {
        // Otherwise the tool marker is appended to the end of a sentence and the
        // transcript stops being greppable line-by-line.
        let mut events = channel_of(vec![
            token("Let me check."),
            AgentEvent::ToolAction {
                tool_name: "search".to_string(),
                description: None,
                invocation_number: 1,
                parameters: Vec::new(),
            },
            final_response(),
        ]);

        let mut out = Vec::new();
        render_turn(&mut events, &mut out).await;

        let rendered = String::from_utf8(out).expect("utf-8");
        assert!(
            rendered.starts_with("Let me check.\n[tool: search]\n"),
            "{rendered:?}"
        );
    }

    #[tokio::test]
    async fn the_final_response_is_not_printed_twice() {
        // The container streams the answer as tokens *and* repeats it in
        // final_response; printing both would duplicate the entire reply.
        let mut events = channel_of(vec![
            token("It is 24C and sunny in Rome."),
            final_response(),
        ]);

        let mut out = Vec::new();
        render_turn(&mut events, &mut out).await;

        let rendered = String::from_utf8(out).expect("utf-8");
        assert_eq!(rendered.matches("sunny in Rome").count(), 1, "{rendered:?}");
    }

    #[tokio::test]
    async fn a_non_streaming_reply_still_renders() {
        // An architecture that only sends final_response must not produce an empty
        // transcript.
        let mut events = channel_of(vec![final_response()]);

        let mut out = Vec::new();
        render_turn(&mut events, &mut out).await;

        assert_eq!(
            String::from_utf8(out).expect("utf-8"),
            "It is 24C and sunny in Rome.\n"
        );
    }

    #[tokio::test]
    async fn a_server_error_ends_the_turn_and_maps_to_a_distinct_code() {
        let mut events = channel_of(vec![
            token("thinking"),
            AgentEvent::ServerError {
                message: "model access denied".to_string(),
            },
        ]);

        let mut out = Vec::new();
        let outcome = render_turn(&mut events, &mut out).await;
        assert_eq!(
            outcome,
            TurnOutcome::ServerError("model access denied".to_string())
        );

        let mut errors = Vec::new();
        let code = outcome_to_code(outcome, &mut errors);
        assert_eq!(code, ExitCode::from(super::super::exit::AGENT_ERROR));
        let rendered = String::from_utf8(errors).expect("utf-8");
        assert!(rendered.contains("model access denied"), "{rendered}");
    }

    #[tokio::test]
    async fn a_closed_channel_without_a_final_response_is_a_disconnect() {
        let mut events = channel_of(vec![token("half a sen")]);
        let mut out = Vec::new();
        let outcome = render_turn(&mut events, &mut out).await;

        assert_eq!(outcome, TurnOutcome::Disconnected);
        // The partial line is terminated, so the next thing printed does not run
        // into it.
        assert_eq!(String::from_utf8(out).expect("utf-8"), "half a sen\n");

        let mut errors = Vec::new();
        assert_eq!(
            outcome_to_code(outcome, &mut errors),
            ExitCode::from(super::super::exit::TRANSPORT)
        );
    }

    #[tokio::test]
    async fn the_transcript_contains_no_escape_sequences() {
        // The redirect acceptance check in prose form: nothing here may emit ANSI,
        // or `aca chat -m … > out.txt` produces a file full of control codes.
        let mut events = channel_of(vec![
            AgentEvent::ToolAction {
                tool_name: "search".to_string(),
                description: Some("Looking it up".to_string()),
                invocation_number: 1,
                parameters: vec![crate::protocol::ToolParameter {
                    name: "q".to_string(),
                    value: "rome weather".to_string(),
                }],
            },
            token("done"),
            final_response(),
        ]);

        let mut out = Vec::new();
        render_turn(&mut events, &mut out).await;

        let rendered = String::from_utf8(out).expect("utf-8");
        assert!(!rendered.contains('\u{1b}'), "{rendered:?}");
        assert!(
            rendered.chars().all(|c| c == '\n' || !c.is_control()),
            "{rendered:?}"
        );
    }
}
