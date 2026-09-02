//! Line-mode sink: a linear, greppable transcript.
//!
//! Plain mode ships before the TUI on purpose. During bring-up a 403, a malformed
//! frame or a panic behind ratatui's alternate screen destroys exactly the
//! diagnostic needed to tell them apart, so chat is proven on a sink whose output
//! survives being redirected to a file.

use std::io::{BufRead, IsTerminal, Write};
use std::process::ExitCode;

use tokio::sync::mpsc::Receiver;

use crate::protocol::AgentEvent;
use crate::telemetry::Secret;
use crate::transport::AgentConnection;

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
pub async fn run(mut conn: AgentConnection, one_shot: Option<String>) -> ExitCode {
    let mut stdout = std::io::stdout();
    tracing::info!(
        session_id = conn.session_id().as_str(),
        "starting plain chat"
    );

    if let Some(text) = one_shot {
        let code = match send_and_render(&mut conn, &text, &mut stdout).await {
            Ok(outcome) => outcome_to_code(outcome, &mut std::io::stderr()),
            Err(code) => code,
        };
        // Best-effort: a failed close cannot change what already happened.
        let _ = conn.close().await;
        return code;
    }

    let stdin = std::io::stdin();
    let interactive = stdin.is_terminal();
    let mut lines = stdin.lock().lines();

    loop {
        if interactive {
            // The prompt marker, so the user's own typing lands after it and the
            // transcript reads the same as the redirected form.
            let _ = write!(stdout, "> ");
            let _ = stdout.flush();
        }
        let Some(line) = lines.next() else {
            break; // EOF: a piped script ran out of input, which is a clean exit.
        };
        let text = match line {
            Ok(text) => text,
            Err(err) => {
                eprintln!("aca: could not read stdin: {err}");
                break;
            }
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if text == "/quit" || text == "/exit" {
            break;
        }
        if !interactive {
            // Echo, so a piped transcript shows what was asked. Skipped when
            // interactive because the terminal already echoed it.
            let _ = writeln!(stdout, "> {text}");
        }

        match send_and_render(&mut conn, text, &mut stdout).await {
            Ok(TurnOutcome::Complete) => continue,
            Ok(outcome) => {
                let code = outcome_to_code(outcome, &mut std::io::stderr());
                let _ = conn.close().await;
                return code;
            }
            Err(code) => {
                let _ = conn.close().await;
                return code;
            }
        }
    }

    let _ = conn.close().await;
    ExitCode::SUCCESS
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
    use crate::protocol::FinalResponse;

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
