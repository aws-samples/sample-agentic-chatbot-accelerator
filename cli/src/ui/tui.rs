//! Full-screen sink: scrollable transcript, live tool indicator, usable input.
//!
//! Consumes the same `mpsc<AgentEvent>` channel as [`super::plain`] — there is no
//! protocol code here, and the two sinks cannot drift on the wire because neither
//! of them touches it.
//!
//! The split that makes this testable: [`App`] is inert data with a synchronous
//! [`App::apply`], so every view transition the acceptance checks care about
//! (tokens accumulating, an indicator appearing and resolving, an unknown event
//! changing nothing) is assertable without a terminal. [`run`] owns the terminal
//! and the `select!`, and holds no logic worth testing.

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::time::Duration;

use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use futures_util::StreamExt;
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph, Wrap};

use crate::protocol::AgentEvent;
use crate::transport::AgentConnection;

/// How often the screen is repainted when something changed.
///
/// Tokens arrive far faster than a terminal can usefully redraw, so frames are
/// coalesced onto this tick rather than drawn per event: a long reply would
/// otherwise spend its time painting instead of reading the socket.
const FRAME_INTERVAL: Duration = Duration::from_millis(33);

/// Who said a line of the transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

/// One message. Assistant turns are appended to while streaming.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub role: Role,
    pub text: String,
}

/// A tool step that has started and not yet reported completion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolStep {
    pub tool_name: String,
    pub description: Option<String>,
}

/// What the status line says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Status {
    /// Waiting for input.
    #[default]
    Idle,
    /// A turn is in flight; tokens may be arriving.
    Streaming,
    /// A problem worth showing that did not end the session.
    Notice(String),
}

/// Everything drawn on screen.
///
/// Pure data: no terminal, no channel, no clock.
#[derive(Debug, Default)]
pub struct App {
    /// Completed turns plus the in-progress assistant message, in order.
    pub transcript: Vec<Turn>,
    /// The input buffer.
    pub input: String,
    /// Byte offset of the caret within [`App::input`]. Always on a char boundary.
    pub cursor: usize,
    /// Tool steps started but not completed, keyed by invocation number so the
    /// `tool_action` / `tool_complete` pair correlates even when a container
    /// omits the counter and both halves default to zero.
    pub active_tools: BTreeMap<i64, ToolStep>,
    pub status: Status,
    /// Lines scrolled **up from the bottom**; `0` follows the stream.
    ///
    /// Measured from the bottom rather than the top so that appending a token
    /// cannot move the viewport: at `0` the newest line is always visible
    /// without anything having to recompute an offset, which is also what makes
    /// a mid-stream resize harmless.
    pub scroll: u16,
    /// Whether the assistant turn at the end of the transcript is still open.
    ///
    /// Tracked explicitly rather than inferred from the last turn's role,
    /// because a closed assistant turn followed by more tokens must start a new
    /// message rather than silently extend the previous answer.
    streaming_into_last: bool,
    /// The most recent `error` frame, cleared when a new turn is sent.
    ///
    /// Drives the exit code so a session that ended on an agent error is still
    /// distinguishable afterwards, even though the TUI stays alive to show it.
    last_server_error: Option<String>,
}

impl App {
    /// Fold one server event into the view state.
    ///
    /// Total over [`AgentEvent`]: an unknown or inert frame changes nothing, so a
    /// container that emits events this build has never seen cannot disturb the
    /// screen.
    pub fn apply(&mut self, event: AgentEvent) {
        match event {
            AgentEvent::TextToken { data, .. } => {
                if self.streaming_into_last {
                    if let Some(turn) = self.transcript.last_mut() {
                        turn.text.push_str(&data);
                    }
                } else {
                    self.transcript.push(Turn {
                        role: Role::Assistant,
                        text: data,
                    });
                    self.streaming_into_last = true;
                }
                self.status = Status::Streaming;
            }
            AgentEvent::ToolAction {
                tool_name,
                description,
                invocation_number,
                ..
            } => {
                self.active_tools.insert(
                    invocation_number,
                    ToolStep {
                        tool_name,
                        description,
                    },
                );
                self.status = Status::Streaming;
            }
            AgentEvent::ToolComplete {
                tool_name,
                invocation_number,
                status,
            } => {
                self.active_tools.remove(&invocation_number);
                // A failed tool is otherwise invisible: the indicator simply
                // disappears and the agent carries on, which reads as success.
                if status != "success" {
                    self.status = Status::Notice(format!("{tool_name} finished with {status}"));
                }
            }
            AgentEvent::FinalResponse(final_response) => {
                if !self.streaming_into_last && !final_response.content.is_empty() {
                    // Nothing streamed, so this is the whole answer — the shape a
                    // non-streaming architecture produces. When tokens *did*
                    // arrive the content is a repeat of them, and appending it
                    // would duplicate the entire reply.
                    self.transcript.push(Turn {
                        role: Role::Assistant,
                        text: final_response.content,
                    });
                }
                self.streaming_into_last = false;
                // A turn that ended with tools still open would leave a
                // permanent "using X" that never resolves.
                self.active_tools.clear();
                if !matches!(self.status, Status::Notice(_)) {
                    self.status = Status::Idle;
                }
            }
            AgentEvent::ServerError { message } => {
                self.streaming_into_last = false;
                self.active_tools.clear();
                self.status = Status::Notice(message.clone());
                self.last_server_error = Some(message);
            }
            AgentEvent::HeartbeatAck => {}
            AgentEvent::Unknown { r#type } => {
                // To the log file, never to the screen: the four architectures
                // may emit types this build does not model, and surfacing them
                // would turn a working chat into a wall of noise.
                tracing::debug!(event_type = %r#type, "ignoring unknown event type");
            }
        }
    }

    /// Record the user's own turn, so the transcript reads as a conversation.
    pub fn push_user_turn(&mut self, text: String) {
        self.transcript.push(Turn {
            role: Role::User,
            text,
        });
        self.streaming_into_last = false;
        self.status = Status::Streaming;
        self.last_server_error = None;
        // Sending pulls the view back to the bottom: a user who scrolled up to
        // re-read something still wants to see the answer they just asked for.
        self.scroll = 0;
    }

    /// Handle a key press. Returns `false` when the user asked to quit.
    pub fn on_key(&mut self, key: KeyEvent) -> bool {
        // Releases and repeats arrive as separate kinds on some terminals;
        // acting on a release would double every keystroke.
        if key.kind == KeyEventKind::Release {
            return true;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        // Any unhandled control or alt combination is dropped rather than typed:
        // without this, Ctrl-D on a non-empty line falls through to the insert
        // arm and puts a literal `d` in the prompt.
        let modified = ctrl || key.modifiers.contains(KeyModifiers::ALT);

        match key.code {
            KeyCode::Char('c') if ctrl => return false,
            // Only quits on an empty line, mirroring a shell: Ctrl-D with text
            // pending would discard what the user typed.
            KeyCode::Char('d') if ctrl && self.input.is_empty() => return false,
            KeyCode::Char('u') if ctrl => {
                self.input.clear();
                self.cursor = 0;
            }
            KeyCode::Char(ch) if !modified => {
                self.input.insert(self.cursor, ch);
                self.cursor += ch.len_utf8();
            }
            KeyCode::Backspace => {
                if let Some(previous) = self.prev_boundary() {
                    self.input.remove(previous);
                    self.cursor = previous;
                }
            }
            KeyCode::Delete if self.cursor < self.input.len() => {
                self.input.remove(self.cursor);
            }
            KeyCode::Left => {
                if let Some(previous) = self.prev_boundary() {
                    self.cursor = previous;
                }
            }
            KeyCode::Right => {
                if let Some(next) = self.next_boundary() {
                    self.cursor = next;
                }
            }
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.input.len(),
            KeyCode::PageUp | KeyCode::Up => self.scroll = self.scroll.saturating_add(1),
            KeyCode::PageDown | KeyCode::Down => self.scroll = self.scroll.saturating_sub(1),
            _ => {}
        }
        true
    }

    /// Take the submitted line, clearing the input buffer.
    ///
    /// Returns `None` for a blank line so Enter on an empty prompt is inert
    /// rather than a turn the agent has to answer.
    pub fn take_submission(&mut self) -> Option<String> {
        let text = self.input.trim().to_string();
        self.input.clear();
        self.cursor = 0;
        if text.is_empty() { None } else { Some(text) }
    }

    /// The exit code this session should produce.
    pub fn exit_code(&self) -> ExitCode {
        match &self.last_server_error {
            Some(_) => ExitCode::from(super::exit::AGENT_ERROR),
            None => ExitCode::SUCCESS,
        }
    }

    /// Byte offset of the char before the caret.
    ///
    /// `String::remove` and cursor moves both panic on a non-boundary index, and
    /// a pasted accented character is enough to hit that, so movement is in
    /// chars rather than bytes throughout.
    fn prev_boundary(&self) -> Option<usize> {
        self.input[..self.cursor]
            .char_indices()
            .next_back()
            .map(|(index, _)| index)
    }

    /// Byte offset of the char after the caret.
    fn next_boundary(&self) -> Option<usize> {
        self.input[self.cursor..]
            .chars()
            .next()
            .map(|ch| self.cursor + ch.len_utf8())
    }
}

/// Render one frame. No IO beyond the frame buffer.
pub fn draw(frame: &mut Frame, app: &App) {
    let [transcript_area, status_area, input_area] = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(3),
    ])
    .areas(frame.area());

    let transcript = Paragraph::new(transcript_lines(app))
        // `trim: false` keeps the agent's own indentation — code blocks and
        // bullet lists are the common case and re-flowing them loses structure.
        .wrap(Wrap { trim: false })
        .block(Block::bordered().title("aca"));
    // Inner height: the border steals a row top and bottom.
    let viewport = transcript_area.height.saturating_sub(2);
    let width = transcript_area.width.saturating_sub(2);
    // Recomputed per frame from the *current* size, which is why a resize
    // mid-stream cannot leave the viewport pointing at a stale offset.
    let total = transcript.line_count(width.max(1)) as u16;
    let offset = total
        .saturating_sub(viewport)
        .saturating_sub(app.scroll.min(total.saturating_sub(viewport)));
    frame.render_widget(transcript.scroll((offset, 0)), transcript_area);

    frame.render_widget(Paragraph::new(status_line(app)), status_area);

    let input = Paragraph::new(app.input.as_str())
        .block(Block::bordered().title_bottom(Line::from(hint(app)).centered()));
    frame.render_widget(input, input_area);

    // Placed on the caret rather than the end of the buffer, so editing mid-line
    // does not lie about where the next character will land. Char count, not
    // byte offset: a multi-byte character occupies one cell.
    let caret = app.input[..app.cursor].chars().count() as u16;
    frame.set_cursor_position((
        input_area.x + 1 + caret.min(input_area.width.saturating_sub(2)),
        input_area.y + 1,
    ));
}

/// The transcript as styled lines, newest last.
fn transcript_lines(app: &App) -> Vec<Line<'_>> {
    let mut lines: Vec<Line> = Vec::new();
    for turn in &app.transcript {
        let (prefix, style) = match turn.role {
            Role::User => ("> ", Style::default().fg(Color::Cyan)),
            Role::Assistant => ("", Style::default()),
        };
        // Split on newlines so the agent's own paragraph breaks survive: a
        // single Line containing `\n` renders as one run-together row.
        for (index, text) in turn.text.split('\n').enumerate() {
            let marker = if index == 0 { prefix } else { "" };
            lines.push(Line::from(vec![
                Span::styled(marker, style),
                Span::styled(text.to_string(), style),
            ]));
        }
    }
    lines
}

/// The one-line status area: the tool indicator, or the current state.
fn status_line(app: &App) -> Line<'static> {
    if let Some(step) = app.active_tools.values().next_back() {
        let extra = if app.active_tools.len() > 1 {
            format!(" (+{} more)", app.active_tools.len() - 1)
        } else {
            String::new()
        };
        let detail = step
            .description
            .as_deref()
            .map(|text| format!(": {text}"))
            .unwrap_or_default();
        return Line::from(Span::styled(
            format!("using {}{detail}{extra}", step.tool_name),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ));
    }
    match &app.status {
        Status::Idle => Line::from(Span::styled("ready", Style::default().fg(Color::DarkGray))),
        Status::Streaming => Line::from(Span::styled(
            "thinking…",
            Style::default().fg(Color::DarkGray),
        )),
        Status::Notice(message) => Line::from(Span::styled(
            message.clone(),
            Style::default().fg(Color::Red),
        )),
    }
}

/// The key hint under the input box.
fn hint(app: &App) -> &'static str {
    match app.status {
        Status::Streaming => " enter send · ctrl-c quit · ↑↓ scroll · replying… ",
        _ => " enter send · ctrl-c quit · ↑↓ scroll ",
    }
}

/// Restore the terminal after the alternate screen.
///
/// Exposed so the T3 panic hook can call it from `main`: without it a panic
/// inside the alternate screen leaves the terminal in raw mode with the
/// backtrace scrolled off an inaccessible buffer. Idempotent, so calling it on
/// both the panic path and the normal path is safe.
pub fn restore_terminal() {
    ratatui::restore();
}

/// Own the terminal and run the event loop until the user quits or the socket
/// closes.
pub async fn run(conn: AgentConnection) -> anyhow::Result<ExitCode> {
    let mut terminal = ratatui::try_init()?;
    // The loop's result is held rather than propagated so the terminal is
    // restored on *every* path, including an error mid-draw.
    let outcome = event_loop(&mut terminal, conn).await;
    restore_terminal();
    outcome
}

/// The event loop proper, with the terminal already initialised.
async fn event_loop(
    terminal: &mut ratatui::DefaultTerminal,
    mut conn: AgentConnection,
) -> anyhow::Result<ExitCode> {
    let mut app = App::default();
    let mut keys = EventStream::new();
    let mut ticker = tokio::time::interval(FRAME_INTERVAL);
    // Skip the missed-tick catch-up: a slow frame otherwise queues ticks and the
    // loop spends the next few iterations redrawing instead of reading events.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    terminal.draw(|frame| draw(frame, &app))?;
    let mut dirty = false;
    let mut disconnected = false;

    loop {
        tokio::select! {
            event = conn.events.recv() => match event {
                Some(event) => {
                    app.apply(event);
                    dirty = true;
                }
                None => {
                    // The read loop ended, so the socket is gone. Shown rather
                    // than exited on silently, then the loop stops.
                    app.status = Status::Notice(
                        "the connection closed; press ctrl-c to exit".to_string(),
                    );
                    disconnected = true;
                    terminal.draw(|frame| draw(frame, &app))?;
                    break;
                }
            },
            key = keys.next() => match key {
                Some(Ok(Event::Key(key))) => {
                    if !app.on_key(key) {
                        break;
                    }
                    if key.code == KeyCode::Enter && key.kind != KeyEventKind::Release
                        && let Some(text) = app.take_submission()
                    {
                        if text == "/quit" || text == "/exit" {
                            break;
                        }
                        app.push_user_turn(text.clone());
                        // Awaited inline: this is a single frame write, not the
                        // reply, so the input box is only unusable for the
                        // duration of a socket write.
                        if let Err(err) = conn.send_text(&text).await {
                            tracing::error!(error = %err, "send failed");
                            app.status = Status::Notice(format!("could not send: {err}"));
                        }
                    }
                    dirty = true;
                }
                Some(Ok(Event::Resize(..))) => dirty = true,
                Some(Ok(_)) => {}
                Some(Err(err)) => {
                    tracing::error!(error = %err, "terminal event stream failed");
                    break;
                }
                // stdin closed: nothing can arrive, so holding the screen open
                // would be a hang with no way out.
                None => break,
            },
            _ = ticker.tick(), if dirty => {
                terminal.draw(|frame| draw(frame, &app))?;
                dirty = false;
            }
        }
    }

    let code = if disconnected {
        ExitCode::from(super::exit::TRANSPORT)
    } else {
        app.exit_code()
    };
    // Best-effort: a failed close cannot change what already happened.
    let _ = conn.close().await;
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{FinalResponse, ToolParameter};

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn token(data: &str) -> AgentEvent {
        AgentEvent::TextToken {
            data: data.to_string(),
            sequence_number: 0,
            run_id: None,
        }
    }

    fn tool_action(name: &str, invocation: i64) -> AgentEvent {
        AgentEvent::ToolAction {
            tool_name: name.to_string(),
            description: Some("Search the KB".to_string()),
            invocation_number: invocation,
            parameters: vec![ToolParameter {
                name: "query".to_string(),
                value: "rome".to_string(),
            }],
        }
    }

    fn final_response(content: &str) -> AgentEvent {
        AgentEvent::FinalResponse(FinalResponse {
            content: content.to_string(),
            session_id: "s".to_string(),
            message_id: "m".to_string(),
            references: None,
            reasoning_content: None,
            structured_output: None,
        })
    }

    #[test]
    fn tokens_accumulate_into_one_assistant_turn() {
        let mut app = App::default();
        app.push_user_turn("hi".to_string());
        for part in ["It is ", "24C in ", "Rome."] {
            app.apply(token(part));
        }

        assert_eq!(app.status, Status::Streaming);
        assert_eq!(
            app.transcript,
            vec![
                Turn {
                    role: Role::User,
                    text: "hi".to_string()
                },
                Turn {
                    role: Role::Assistant,
                    text: "It is 24C in Rome.".to_string()
                },
            ]
        );
    }

    #[test]
    fn a_tool_step_appears_then_resolves_on_completion() {
        // The acceptance check in unit form: the indicator has to *disappear*,
        // not merely appear, or every reply after a tool call looks stuck.
        let mut app = App::default();
        app.apply(tool_action("retrieve", 2));
        assert_eq!(
            app.active_tools.get(&2),
            Some(&ToolStep {
                tool_name: "retrieve".to_string(),
                description: Some("Search the KB".to_string()),
            })
        );
        let rendered = status_line(&app).to_string();
        assert!(rendered.contains("using retrieve"), "{rendered}");

        app.apply(AgentEvent::ToolComplete {
            tool_name: "retrieve".to_string(),
            invocation_number: 2,
            status: "success".to_string(),
        });
        assert!(app.active_tools.is_empty());
        assert_eq!(app.status, Status::Streaming);
    }

    #[test]
    fn a_failed_tool_becomes_a_visible_notice() {
        let mut app = App::default();
        app.apply(tool_action("retrieve", 1));
        app.apply(AgentEvent::ToolComplete {
            tool_name: "retrieve".to_string(),
            invocation_number: 1,
            status: "error".to_string(),
        });

        assert!(app.active_tools.is_empty());
        let Status::Notice(message) = &app.status else {
            panic!("expected a notice, got {:?}", app.status);
        };
        assert!(message.contains("retrieve"), "{message}");
        assert!(message.contains("error"), "{message}");
    }

    #[test]
    fn an_unresolved_tool_does_not_outlive_its_turn() {
        // A container that drops `tool_complete` would otherwise leave a
        // permanent "using X" on screen for the rest of the session.
        let mut app = App::default();
        app.apply(tool_action("retrieve", 1));
        app.apply(token("done"));
        app.apply(final_response("done"));

        assert!(app.active_tools.is_empty());
        assert_eq!(app.status, Status::Idle);
    }

    #[test]
    fn the_final_response_does_not_duplicate_streamed_text() {
        let mut app = App::default();
        app.apply(token("It is 24C in Rome."));
        app.apply(final_response("It is 24C in Rome."));

        assert_eq!(app.transcript.len(), 1);
        assert_eq!(app.transcript[0].text, "It is 24C in Rome.");
        assert_eq!(app.status, Status::Idle);
    }

    #[test]
    fn a_non_streaming_reply_still_lands_in_the_transcript() {
        let mut app = App::default();
        app.apply(final_response("the whole answer"));

        assert_eq!(
            app.transcript,
            vec![Turn {
                role: Role::Assistant,
                text: "the whole answer".to_string()
            }]
        );
    }

    #[test]
    fn a_second_turn_starts_a_new_assistant_message() {
        let mut app = App::default();
        app.apply(token("first"));
        app.apply(final_response("first"));
        app.apply(token("second"));

        assert_eq!(app.transcript.len(), 2);
        assert_eq!(app.transcript[1].text, "second");
    }

    #[test]
    fn inert_and_unknown_events_change_nothing() {
        let mut app = App::default();
        app.apply(token("hello"));
        let before = format!("{:?}", app.transcript);
        let status_before = app.status.clone();

        app.apply(AgentEvent::HeartbeatAck);
        app.apply(AgentEvent::Unknown {
            r#type: "bidi_audio_stream".to_string(),
        });

        assert_eq!(format!("{:?}", app.transcript), before);
        assert_eq!(app.status, status_before);
        assert!(app.active_tools.is_empty());
    }

    #[test]
    fn a_server_error_shows_and_sets_the_exit_code() {
        let mut app = App::default();
        app.apply(token("thinking"));
        app.apply(AgentEvent::ServerError {
            message: "model access denied".to_string(),
        });

        assert_eq!(
            app.status,
            Status::Notice("model access denied".to_string())
        );
        assert_eq!(
            app.exit_code(),
            ExitCode::from(super::super::exit::AGENT_ERROR)
        );

        // A later successful turn clears it: quitting after recovering should
        // not report failure.
        app.push_user_turn("retry".to_string());
        assert_eq!(app.exit_code(), ExitCode::SUCCESS);
    }

    #[test]
    fn typing_submitting_and_deleting() {
        let mut app = App::default();
        for ch in "hello".chars() {
            assert!(app.on_key(key(KeyCode::Char(ch))));
        }
        assert_eq!(app.input, "hello");
        assert_eq!(app.cursor, 5);

        assert!(app.on_key(key(KeyCode::Backspace)));
        assert_eq!(app.input, "hell");
        assert_eq!(app.cursor, 4);

        assert_eq!(app.take_submission(), Some("hell".to_string()));
        assert_eq!(app.input, "");
        assert_eq!(app.cursor, 0);
        // Enter on an empty buffer must not send a turn.
        assert_eq!(app.take_submission(), None);
    }

    #[test]
    fn ctrl_c_quits_and_ctrl_d_only_quits_on_an_empty_line() {
        let mut app = App::default();
        assert!(!app.on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)));

        let mut app = App::default();
        app.on_key(key(KeyCode::Char('x')));
        // Text pending: Ctrl-D must not discard it.
        assert!(app.on_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL)));
        // Nor may the declined shortcut be typed as a character — that is what
        // makes the line non-empty forever and the shortcut unreachable.
        assert_eq!(app.input, "x");
        app.on_key(key(KeyCode::Backspace));
        assert!(!app.on_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL)));
    }

    #[test]
    fn unhandled_modifier_combinations_are_not_typed() {
        let mut app = App::default();
        for modifiers in [KeyModifiers::CONTROL, KeyModifiers::ALT] {
            for ch in ['a', 'z', '1'] {
                app.on_key(KeyEvent::new(KeyCode::Char(ch), modifiers));
            }
        }
        assert_eq!(app.input, "");
    }

    #[test]
    fn a_key_release_is_not_a_keystroke() {
        // Windows terminals deliver press *and* release; acting on both would
        // double every character typed.
        let mut app = App::default();
        let mut release = key(KeyCode::Char('a'));
        release.kind = KeyEventKind::Release;
        assert!(app.on_key(release));
        assert_eq!(app.input, "");
    }

    #[test]
    fn editing_is_char_wise_not_byte_wise() {
        // A byte-indexed cursor panics on the first accented character, which is
        // one paste away in any non-English conversation.
        let mut app = App::default();
        for ch in "café".chars() {
            app.on_key(key(KeyCode::Char(ch)));
        }
        assert_eq!(app.cursor, "café".len());

        app.on_key(key(KeyCode::Left));
        app.on_key(key(KeyCode::Left));
        assert_eq!(app.cursor, 2);
        app.on_key(key(KeyCode::Char('X')));
        assert_eq!(app.input, "caXfé");

        app.on_key(key(KeyCode::End));
        app.on_key(key(KeyCode::Backspace));
        assert_eq!(app.input, "caXf");
    }

    #[test]
    fn scrolling_is_measured_from_the_bottom_and_sending_returns_to_it() {
        let mut app = App::default();
        assert_eq!(app.scroll, 0);
        app.on_key(key(KeyCode::PageUp));
        app.on_key(key(KeyCode::PageUp));
        assert_eq!(app.scroll, 2);
        app.on_key(key(KeyCode::PageDown));
        assert_eq!(app.scroll, 1);
        // Cannot scroll below the newest line.
        app.on_key(key(KeyCode::PageDown));
        app.on_key(key(KeyCode::PageDown));
        assert_eq!(app.scroll, 0);

        app.on_key(key(KeyCode::PageUp));
        app.push_user_turn("what about tomorrow?".to_string());
        assert_eq!(app.scroll, 0, "sending must snap back to the newest line");
    }

    #[test]
    fn multi_line_agent_text_renders_as_separate_lines() {
        let mut app = App::default();
        app.apply(token("first\nsecond"));
        let lines = transcript_lines(&app);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].to_string(), "first");
        assert_eq!(lines[1].to_string(), "second");
    }

    #[test]
    fn a_user_turn_is_marked_in_the_transcript() {
        let mut app = App::default();
        app.push_user_turn("hi".to_string());
        assert_eq!(transcript_lines(&app)[0].to_string(), "> hi");
    }

    /// Draws into a fixed-size test backend at several sizes, which is the only
    /// offline way to cover the acceptance check about resizing mid-stream: the
    /// arithmetic in `draw` is where an out-of-range scroll offset would panic
    /// or blank the transcript.
    #[test]
    fn drawing_survives_every_size_including_degenerate_ones() {
        let mut app = App::default();
        app.push_user_turn("hi".to_string());
        for _ in 0..40 {
            app.apply(token("a long stretch of streamed words "));
        }
        app.apply(tool_action("retrieve", 1));

        for (width, height) in [(80, 24), (80, 5), (20, 4), (10, 3), (4, 2), (1, 1)] {
            for scroll in [0, 3, 500] {
                app.scroll = scroll;
                let backend = ratatui::backend::TestBackend::new(width, height);
                let mut terminal = ratatui::Terminal::new(backend).expect("terminal");
                terminal
                    .draw(|frame| draw(frame, &app))
                    .unwrap_or_else(|err| panic!("draw failed at {width}x{height}: {err}"));
            }
        }
    }

    /// Flatten a drawn buffer into one string, so a test can ask what is *on
    /// screen* rather than what is in `App`.
    fn rendered(app: &App, width: u16, height: u16) -> String {
        let backend = ratatui::backend::TestBackend::new(width, height);
        let mut terminal = ratatui::Terminal::new(backend).expect("terminal");
        let frame = terminal.draw(|frame| draw(frame, app)).expect("draw");
        frame
            .buffer
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    #[test]
    fn the_frame_shows_the_streamed_text_the_prompt_and_the_indicator() {
        // The state-level tests prove `apply` is right; this proves the three
        // things the acceptance checks describe actually reach the screen.
        let mut app = App::default();
        app.push_user_turn("weather in Rome?".to_string());
        app.apply(token("It is 24C"));
        app.apply(tool_action("retrieve", 1));
        for ch in "and to".chars() {
            app.on_key(key(KeyCode::Char(ch)));
        }

        let screen = rendered(&app, 60, 12);
        assert!(screen.contains("> weather in Rome?"), "{screen}");
        assert!(screen.contains("It is 24C"), "{screen}");
        assert!(screen.contains("using retrieve"), "{screen}");
        // The input box stays usable while the tool runs — the whole reason for
        // a TUI over line mode.
        assert!(screen.contains("and to"), "{screen}");
    }

    #[test]
    fn the_newest_line_is_visible_without_scrolling() {
        // With the offset measured from the top instead, a transcript longer than
        // the viewport would keep showing its first screen while tokens streamed
        // off the bottom.
        let mut app = App::default();
        for index in 0..40 {
            app.push_user_turn(format!("question {index}"));
        }
        app.apply(token("the newest answer"));

        let screen = rendered(&app, 40, 10);
        assert!(screen.contains("the newest answer"), "{screen}");
        assert!(!screen.contains("question 0 "), "{screen}");
    }
}
