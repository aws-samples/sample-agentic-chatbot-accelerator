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
use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use futures_util::StreamExt;
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, List, ListState, Paragraph, Wrap};
use tokio::sync::{Mutex, mpsc};

use crate::discovery::{Selectable, Target};
use crate::protocol::AgentEvent;
use crate::session::{Session, SessionControl};

use super::{Submission, parse_submission};

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
    /// The CLI itself — session boundaries, command output, refusals.
    ///
    /// In the transcript rather than the status line because these are events in
    /// the conversation's history: "the agent no longer remembers the above" has
    /// to stay visible at the point it happened, not vanish on the next redraw.
    System,
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

/// Which view has the keyboard.
#[derive(Debug, Default)]
pub enum Mode {
    #[default]
    Chat,
    /// `/agent` is open. The chat keeps streaming underneath; only the keyboard
    /// and the upper pane are taken over.
    Picker(Picker),
}

/// The `/agent` chooser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Picker {
    pub rows: Vec<Selectable>,
    /// Index into [`Picker::rows`]. Always in range while `rows` is non-empty.
    pub selected: usize,
}

impl Picker {
    fn new(rows: Vec<Selectable>) -> Self {
        Self { rows, selected: 0 }
    }

    /// Move the highlight, clamped at both ends.
    ///
    /// Clamped rather than wrapping: holding a cursor key to reach the end of a
    /// long list should stop there, not silently return to the top and select the
    /// wrong agent.
    fn move_by(&mut self, delta: isize) {
        let last = self.rows.len().saturating_sub(1);
        self.selected = self.selected.saturating_add_signed(delta).min(last);
    }
}

/// What a keystroke asked the event loop to do.
///
/// [`App::on_key`] returns this instead of doing the work: every one of these
/// needs IO the state has no business owning — a socket write, a dial, an AppSync
/// query — and returning them keeps the whole of the key handling assertable
/// without any of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// State may have changed; nothing else to do.
    Continue,
    /// Leave the chat.
    Quit,
    /// Transmit this text. Already appended to the transcript.
    Send(String),
    /// Open a fresh session against the current agent (`/session`).
    NewSession,
    /// Fetch the agent list, then open the picker (`/agent`).
    ListAgents,
    /// The picker resolved: open a fresh session against this target.
    Switch(Target),
}

/// The `/help` body, built from the one command table both sinks parse.
fn help_text() -> String {
    let mut text = String::from("commands:");
    for (name, description) in super::COMMANDS {
        text.push_str(&format!("\n  {name:<10} {description}"));
    }
    text
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
    /// What the CLI is doing on the user's behalf right now: opening a session,
    /// listing agents. `None` when idle.
    ///
    /// Separate from [`App::status`] rather than a variant of it, because the two
    /// change independently: a `/session` typed mid-reply is still opening while
    /// the *old* connection streams its last tokens, and a `TextToken` setting
    /// `status` would otherwise erase the indicator that says why the prompt is
    /// not accepting input.
    pub working: Option<String>,
    /// Which view has the keyboard.
    pub mode: Mode,
    /// `runtime id / qualifier` of the current agent, shown in the title.
    pub agent: String,
    /// The current session id, shown so it can be pasted into a log query.
    pub session: String,
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

    /// Note something the CLI itself did, in the transcript.
    pub fn push_system(&mut self, text: impl Into<String>) {
        self.transcript.push(Turn {
            role: Role::System,
            text: text.into(),
        });
        self.streaming_into_last = false;
        self.scroll = 0;
    }

    /// Record that a session is now live, replacing anything on screen.
    ///
    /// **The transcript is cleared.** A new session id is a new container with no
    /// memory of the old conversation, so leaving it on screen would show a
    /// history the agent cannot refer to — the user reads back three lines the
    /// agent has never seen. Keeping it and merely marking the break was tried
    /// first and is worse: two `/session`s in a row left a wall of markers, and
    /// the screen still disagreed with the agent about what had been said.
    ///
    /// The consequence is real and one-way: this is an alternate-screen app, so a
    /// cleared transcript is not in the terminal's scrollback either. It is gone.
    pub fn begin_session(&mut self, target: &Target, session_id: &str) {
        let agent = format!("{} / {}", target.agent_runtime_id, target.qualifier);
        // Whether this replaces a session or opens the first one.
        let replacing = !self.session.is_empty();
        self.transcript.clear();
        if replacing {
            // One line, on an otherwise empty transcript: confirmation that the
            // command did something, since a cleared screen alone is ambiguous
            // between "new session" and "crashed".
            self.push_system(format!("── new session on {agent} ──"));
        }
        self.agent = agent;
        self.session = session_id.to_string();
        self.working = None;
        self.status = Status::Idle;
        self.streaming_into_last = false;
        self.active_tools.clear();
        // Not carried over: the exit code must describe *this* session, and an
        // error from a container that no longer exists would report failure after
        // a perfectly good conversation.
        self.last_server_error = None;
        self.scroll = 0;
    }

    /// Open the `/agent` picker over the transcript.
    pub fn open_picker(&mut self, rows: Vec<Selectable>) {
        self.working = None;
        if rows.is_empty() {
            // Nothing to choose from is not a picker with no rows: an empty list
            // with no way to dismiss it reads as a hang.
            self.status = Status::Notice("no agent has a deployed endpoint to switch to".into());
            return;
        }
        self.mode = Mode::Picker(Picker::new(rows));
        self.status = Status::Idle;
    }

    /// Handle a key press, returning what the loop must do about it.
    pub fn on_key(&mut self, key: KeyEvent) -> Action {
        // Releases and repeats arrive as separate kinds on some terminals;
        // acting on a release would double every keystroke.
        if key.kind == KeyEventKind::Release {
            return Action::Continue;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        // Checked before the mode split: ctrl-c must quit from anywhere,
        // including a picker opened against an agent list that turned out to be
        // useless.
        if ctrl && key.code == KeyCode::Char('c') {
            return Action::Quit;
        }
        if matches!(self.mode, Mode::Picker(_)) {
            return self.picker_key(key);
        }

        // Any unhandled control or alt combination is dropped rather than typed:
        // without this, Ctrl-D on a non-empty line falls through to the insert
        // arm and puts a literal `d` in the prompt.
        let modified = ctrl || key.modifiers.contains(KeyModifiers::ALT);

        match key.code {
            // Only quits on an empty line, mirroring a shell: Ctrl-D with text
            // pending would discard what the user typed.
            KeyCode::Char('d') if ctrl && self.input.is_empty() => return Action::Quit,
            KeyCode::Char('u') if ctrl => {
                self.input.clear();
                self.cursor = 0;
            }
            KeyCode::Enter => return self.submit(),
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
        Action::Continue
    }

    /// Keys while the `/agent` picker is up.
    fn picker_key(&mut self, key: KeyEvent) -> Action {
        let Mode::Picker(picker) = &mut self.mode else {
            return Action::Continue;
        };
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => picker.move_by(-1),
            KeyCode::Down | KeyCode::Char('j') => picker.move_by(1),
            KeyCode::Home => picker.selected = 0,
            KeyCode::End => picker.selected = picker.rows.len().saturating_sub(1),
            KeyCode::Enter => {
                // `selected` is kept in range by `move_by`, but reading it through
                // `get` means a future edit that breaks that invariant cannot
                // panic behind the alternate screen.
                let chosen = picker
                    .rows
                    .get(picker.selected)
                    .map(|row| row.target.clone());
                self.mode = Mode::Chat;
                return match chosen {
                    Some(target) => Action::Switch(target),
                    None => Action::Continue,
                };
            }
            // Esc and Ctrl-C both leave, but only Esc keeps the chat: a picker
            // that could only be answered would trap someone who typed `/agent`
            // by accident.
            KeyCode::Esc => self.mode = Mode::Chat,
            _ => {}
        }
        Action::Continue
    }

    /// Interpret the submitted line: a turn to send, or one of our own commands.
    fn submit(&mut self) -> Action {
        // While a session is being opened there is no socket to write to. The
        // line is *kept* rather than consumed: silently discarding what someone
        // typed is worse than making them press enter again.
        if self.working.is_some() {
            return Action::Continue;
        }
        let Some(text) = self.take_submission() else {
            return Action::Continue;
        };
        match parse_submission(&text) {
            Submission::Turn(text) => {
                self.push_user_turn(text.clone());
                Action::Send(text)
            }
            Submission::Quit => Action::Quit,
            Submission::NewSession => Action::NewSession,
            Submission::ChooseAgent => Action::ListAgents,
            Submission::Help => {
                self.push_system(help_text());
                Action::Continue
            }
            Submission::Unknown(name) => {
                self.push_system(format!("{name} is not a command — /help lists them"));
                Action::Continue
            }
        }
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
    let [upper_area, status_area, input_area] = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(3),
    ])
    .areas(frame.area());

    match &app.mode {
        Mode::Chat => draw_transcript(frame, app, upper_area),
        // Replaces the transcript rather than floating over it: a centred overlay
        // has to be clipped against every terminal size, and the transcript is
        // still there when the picker closes.
        Mode::Picker(picker) => draw_picker(frame, picker, upper_area),
    }

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

/// The scrolling conversation pane.
fn draw_transcript(frame: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    let mut block = Block::bordered().title(title(app));
    if !app.session.is_empty() {
        // Bottom-right so it is out of the way but copyable: this is the id a
        // CloudWatch query needs, and it is otherwise nowhere on screen.
        block =
            block.title_bottom(Line::from(format!(" session {} ", app.session)).right_aligned());
    }

    let transcript = Paragraph::new(transcript_lines(app))
        // `trim: false` keeps the agent's own indentation — code blocks and
        // bullet lists are the common case and re-flowing them loses structure.
        .wrap(Wrap { trim: false })
        .block(block);
    // Inner height: the border steals a row top and bottom.
    let viewport = area.height.saturating_sub(2);
    let width = area.width.saturating_sub(2);
    // Recomputed per frame from the *current* size, which is why a resize
    // mid-stream cannot leave the viewport pointing at a stale offset.
    let total = transcript.line_count(width.max(1)) as u16;
    let offset = total
        .saturating_sub(viewport)
        .saturating_sub(app.scroll.min(total.saturating_sub(viewport)));
    frame.render_widget(transcript.scroll((offset, 0)), area);
}

/// The `/agent` list.
fn draw_picker(frame: &mut Frame, picker: &Picker, area: ratatui::layout::Rect) {
    let list = List::new(picker.rows.iter().map(|row| row.label.as_str()))
        .block(
            Block::bordered()
                .title("switch agent")
                .title_bottom(Line::from(" ↑↓ move · enter switch · esc cancel ").centered()),
        )
        .highlight_symbol("▸ ")
        .highlight_style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        );

    // Built per frame rather than held in `App`: the widget's own offset logic
    // scrolls the selection into view, so `App` never has to know the height of a
    // pane it cannot see.
    let mut state = ListState::default().with_selected(Some(picker.selected));
    frame.render_stateful_widget(list, area, &mut state);
}

/// The transcript block's title: which agent this is.
fn title(app: &App) -> String {
    if app.agent.is_empty() {
        "aca".to_string()
    } else {
        format!("aca — {}", app.agent)
    }
}

/// The transcript as styled lines, newest last.
fn transcript_lines(app: &App) -> Vec<Line<'_>> {
    let mut lines: Vec<Line> = Vec::new();
    for turn in &app.transcript {
        let (prefix, style) = match turn.role {
            Role::User => ("> ", Style::default().fg(Color::Cyan)),
            Role::Assistant => ("", Style::default()),
            // Dim and unprefixed, so a session marker or a command's output is
            // visibly not something the agent said.
            Role::System => ("", Style::default().fg(Color::DarkGray)),
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
    // Ahead of the tool indicator: while a session is opening there is no socket,
    // and a leftover "using X" from the previous one would be a lie.
    if let Some(what) = &app.working {
        return Line::from(Span::styled(
            format!("{what}… (anything you type is kept)"),
            Style::default().fg(Color::Yellow),
        ));
    }
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
    if matches!(app.mode, Mode::Picker(_)) {
        // The picker owns the keyboard, so the chat hints would be wrong.
        return " ↑↓ move · enter switch · esc cancel ";
    }
    if app.working.is_some() {
        return " enter is held until the session is ready ";
    }
    match app.status {
        Status::Streaming => " enter send · /help · ctrl-c quit · ↑↓ scroll · replying… ",
        _ => " enter send · /help commands · ctrl-c quit · ↑↓ scroll ",
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

/// Own the terminal and run the event loop until the user quits.
pub async fn run(session: Session, manager: Box<dyn SessionControl>) -> anyhow::Result<ExitCode> {
    let mut terminal = ratatui::try_init()?;
    // The loop's result is held rather than propagated so the terminal is
    // restored on *every* path, including an error mid-draw.
    let outcome = event_loop(&mut terminal, session, Arc::new(Mutex::new(manager))).await;
    restore_terminal();
    outcome
}

/// Anything the loop reacts to that did not come from the keyboard.
///
/// One channel for events *and* session outcomes, rather than a select branch per
/// source, because the loop has to be able to replace its connection: a branch
/// holding `&mut` a receiver borrows it for the whole `select!`, so the handler
/// that swaps in a new one cannot compile. Pumping every connection into one
/// permanent channel sidesteps that entirely.
enum Message {
    /// A server event from the connection tagged `generation`.
    Event { generation: u64, event: AgentEvent },
    /// That connection's stream ended.
    Ended { generation: u64 },
    /// A requested session is up.
    Opened {
        generation: u64,
        session: Box<Session>,
    },
    /// A requested session could not be opened, or the listing failed.
    Failed { generation: u64, error: String },
    /// The agent list came back.
    Agents {
        generation: u64,
        rows: Vec<Selectable>,
    },
}

/// The event loop proper, with the terminal already initialised.
async fn event_loop(
    terminal: &mut ratatui::DefaultTerminal,
    session: Session,
    manager: Arc<Mutex<Box<dyn SessionControl>>>,
) -> anyhow::Result<ExitCode> {
    let mut app = App::default();
    let mut keys = EventStream::new();
    let mut ticker = tokio::time::interval(FRAME_INTERVAL);
    // Skip the missed-tick catch-up: a slow frame otherwise queues ticks and the
    // loop spends the next few iterations redrawing instead of reading events.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // Depth 1 is enough for the request/response messages; the pump's events are
    // the volume, and backpressure there is the same bound the socket already had.
    let (messages_tx, mut messages) = mpsc::channel::<Message>(256);

    // Tags the live connection. The initial session is 0; every later request
    // takes the next id, and an `Opened` adopts the id of the request that
    // produced it — which is what lets a stale pump be recognised and ignored.
    let mut generation = 0_u64;
    let mut next_id = 1_u64;
    let mut target = session.target.clone();
    app.begin_session(&target, session.connection.session_id().as_str());
    let (mut writer, events) = session.connection.split();
    tokio::spawn(pump(events, messages_tx.clone(), generation));

    // The id of an in-flight request, or `None` when idle. Doubles as the busy
    // flag: exactly one open-or-list may be outstanding, so a second `/session`
    // while the first is still dialling is refused rather than racing it and
    // leaking a container.
    let mut pending: Option<u64> = None;

    terminal.draw(|frame| draw(frame, &app))?;
    let mut dirty = false;
    let mut quit = false;
    // Whether there is still a socket. Quitting without one is a transport
    // failure for a script's purposes, even though the window stayed open.
    let mut live = true;

    while !quit {
        tokio::select! {
            message = messages.recv() => match message {
                Some(Message::Event { generation: from, event }) => {
                    // A superseded connection's queued events must not land in
                    // the new session's transcript.
                    if from == generation {
                        app.apply(event);
                        dirty = true;
                    }
                }
                Some(Message::Ended { generation: from }) => {
                    if from == generation {
                        // Not fatal any more: `/session` can recover, which is
                        // the whole point of having it. Before these commands
                        // existed the only option was to exit and start again.
                        live = false;
                        app.status = Status::Notice(
                            "the connection closed — /session starts a new one, ctrl-c exits"
                                .to_string(),
                        );
                        dirty = true;
                    }
                }
                Some(Message::Opened { generation: from, session }) => {
                    if pending == Some(from) {
                        pending = None;
                        generation = from;
                        live = true;
                        target = session.target.clone();
                        app.begin_session(&target, session.connection.session_id().as_str());
                        let (new_writer, events) = session.connection.split();
                        // Replaced *after* the new socket is up, so a failed
                        // reconnect leaves the old conversation usable.
                        let previous = std::mem::replace(&mut writer, new_writer);
                        tokio::spawn(async move { let _ = previous.close().await; });
                        tokio::spawn(pump(events, messages_tx.clone(), from));
                        dirty = true;
                    }
                }
                Some(Message::Failed { generation: from, error }) => {
                    if pending == Some(from) {
                        pending = None;
                        app.working = None;
                        tracing::error!(error = %error, "session request failed");
                        app.status = Status::Notice(error);
                        dirty = true;
                    }
                }
                Some(Message::Agents { generation: from, rows }) => {
                    if pending == Some(from) {
                        pending = None;
                        app.open_picker(rows);
                        dirty = true;
                    }
                }
                // Only possible once every sender is gone, which cannot happen
                // while the loop holds `messages_tx`.
                None => break,
            },
            key = keys.next() => match key {
                Some(Ok(Event::Key(key))) => {
                    match app.on_key(key) {
                        Action::Continue => {}
                        Action::Quit => quit = true,
                        Action::Send(text) => {
                            // Awaited inline: this is one frame write, not the
                            // reply, so the input box is only unusable for the
                            // duration of a socket write.
                            if let Err(err) = writer.send_text(&text).await {
                                tracing::error!(error = %err, "send failed");
                                app.status = Status::Notice(format!("could not send: {err}"));
                            }
                        }
                        // `/session` reconnects to whatever is current, so it is
                        // the same code path as the picker's choice.
                        Action::NewSession => issue(
                            Request::Open(target.clone()),
                            &mut app,
                            &mut pending,
                            &mut next_id,
                            &manager,
                            &messages_tx,
                        ),
                        Action::Switch(chosen) => issue(
                            Request::Open(chosen),
                            &mut app,
                            &mut pending,
                            &mut next_id,
                            &manager,
                            &messages_tx,
                        ),
                        Action::ListAgents => issue(
                            Request::Agents,
                            &mut app,
                            &mut pending,
                            &mut next_id,
                            &manager,
                            &messages_tx,
                        ),
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

    let code = if live {
        app.exit_code()
    } else {
        ExitCode::from(super::exit::TRANSPORT)
    };
    // Best-effort: a failed close cannot change what already happened.
    let _ = writer.close().await;
    Ok(code)
}

/// What the loop wants from the session manager.
enum Request {
    /// Open a fresh session against this target.
    Open(Target),
    /// Fetch the agent list for the picker.
    Agents,
}

/// Start a request on its own task and record it as pending.
///
/// Spawned rather than awaited in place because both requests are slow — a new
/// session id is a cold microVM start, and `CONNECT_TIMEOUT` allows a minute —
/// and awaiting inside the key handler would freeze the terminal for that whole
/// time with no way to cancel, including ctrl-c.
fn issue(
    request: Request,
    app: &mut App,
    pending: &mut Option<u64>,
    next_id: &mut u64,
    manager: &Arc<Mutex<Box<dyn SessionControl>>>,
    to: &mpsc::Sender<Message>,
) {
    if pending.is_some() {
        // Serialised on purpose: two overlapping opens would leave whichever
        // container lost the race running until its idle timeout. Said in the
        // transcript rather than the status line, which the in-progress indicator
        // already occupies.
        app.push_system("still working on the previous command");
        return;
    }
    let id = *next_id;
    *next_id += 1;
    *pending = Some(id);
    app.working = Some(
        match request {
            Request::Open(_) => "starting a new session",
            Request::Agents => "listing agents",
        }
        .to_string(),
    );

    let manager = Arc::clone(manager);
    let to = to.clone();
    tokio::spawn(async move {
        // Uncontended by construction: `pending` admits one request at a time.
        let mut manager = manager.lock().await;
        let message = match request {
            Request::Open(target) => match manager.open(target).await {
                Ok(session) => Message::Opened {
                    generation: id,
                    session: Box::new(session),
                },
                Err(error) => Message::Failed {
                    generation: id,
                    error: format!("could not start a session: {error}"),
                },
            },
            Request::Agents => match manager.agents().await {
                Ok(agents) => Message::Agents {
                    generation: id,
                    rows: crate::discovery::selectable_targets(&agents),
                },
                Err(error) => Message::Failed {
                    generation: id,
                    error: format!("could not list agents: {error}"),
                },
            },
        };
        let _ = to.send(message).await;
    });
}

/// Forward one connection's events into the loop's channel, tagged.
///
/// The tag is what makes a switch safe: events already queued from the previous
/// container arrive after the new session has started, and would otherwise be
/// folded into a transcript they have nothing to do with.
async fn pump(mut events: mpsc::Receiver<AgentEvent>, to: mpsc::Sender<Message>, generation: u64) {
    while let Some(event) = events.recv().await {
        if to.send(Message::Event { generation, event }).await.is_err() {
            return; // The loop is gone.
        }
    }
    let _ = to.send(Message::Ended { generation }).await;
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
            assert_eq!(app.on_key(key(KeyCode::Char(ch))), Action::Continue);
        }
        assert_eq!(app.input, "hello");
        assert_eq!(app.cursor, 5);

        assert_eq!(app.on_key(key(KeyCode::Backspace)), Action::Continue);
        assert_eq!(app.input, "hell");
        assert_eq!(app.cursor, 4);

        assert_eq!(
            app.on_key(key(KeyCode::Enter)),
            Action::Send("hell".to_string())
        );
        assert_eq!(app.input, "");
        assert_eq!(app.cursor, 0);
        // Enter on an empty buffer must not send a turn.
        assert_eq!(app.on_key(key(KeyCode::Enter)), Action::Continue);
    }

    #[test]
    fn ctrl_c_quits_and_ctrl_d_only_quits_on_an_empty_line() {
        let mut app = App::default();
        assert_eq!(
            app.on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Action::Quit
        );

        let mut app = App::default();
        app.on_key(key(KeyCode::Char('x')));
        // Text pending: Ctrl-D must not discard it.
        assert_eq!(
            app.on_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL)),
            Action::Continue
        );
        // Nor may the declined shortcut be typed as a character — that is what
        // makes the line non-empty forever and the shortcut unreachable.
        assert_eq!(app.input, "x");
        app.on_key(key(KeyCode::Backspace));
        assert_eq!(
            app.on_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL)),
            Action::Quit
        );
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
        assert_eq!(app.on_key(release), Action::Continue);
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

    /// Type `text` and press Enter, returning what the loop was asked to do.
    fn submit(app: &mut App, text: &str) -> Action {
        for ch in text.chars() {
            app.on_key(key(KeyCode::Char(ch)));
        }
        app.on_key(key(KeyCode::Enter))
    }

    fn target(name: &str, qualifier: &str) -> Target {
        Target {
            agent_runtime_id: format!("{name}-AbCdEf1234"),
            qualifier: qualifier.to_string(),
            runtime_version: "3".to_string(),
        }
    }

    #[test]
    fn the_session_and_agent_commands_reach_the_loop_rather_than_the_agent() {
        // The point of the whole change: these two lines must never be sent to
        // the agent as questions.
        let mut app = App::default();
        assert_eq!(submit(&mut app, "/session"), Action::NewSession);
        assert_eq!(submit(&mut app, "/agent"), Action::ListAgents);
        // Neither appears in the transcript as something the user asked.
        assert!(
            !app.transcript.iter().any(|turn| turn.role == Role::User),
            "{:?}",
            app.transcript
        );
    }

    #[test]
    fn an_ordinary_turn_is_still_sent_and_recorded() {
        let mut app = App::default();
        assert_eq!(
            submit(&mut app, "what is the weather in Rome?"),
            Action::Send("what is the weather in Rome?".to_string())
        );
        assert_eq!(app.transcript[0].role, Role::User);
    }

    #[test]
    fn help_and_bad_commands_answer_locally_without_a_round_trip() {
        let mut app = App::default();
        assert_eq!(submit(&mut app, "/help"), Action::Continue);
        let helped = app.transcript.last().expect("a help line").text.clone();
        for (name, _) in super::super::COMMANDS {
            assert!(helped.contains(name), "{helped} omits {name}");
        }

        // Not a plausible misspelling on purpose — the `typos` pre-commit hook
        // rewrites one of those into the real command and inverts the assertion.
        assert_eq!(submit(&mut app, "/frobnicate"), Action::Continue);
        let complaint = &app.transcript.last().expect("a notice").text;
        assert!(complaint.contains("/frobnicate"), "{complaint}");
        assert!(complaint.contains("/help"), "{complaint}");
        // Both are the CLI talking, not the agent.
        assert!(app.transcript.iter().all(|turn| turn.role == Role::System));
    }

    #[test]
    fn a_new_session_clears_the_conversation_the_agent_cannot_see() {
        // The screen has to agree with the agent about what has been said. A new
        // container remembers nothing, so nothing may remain on screen.
        let mut app = App::default();
        app.begin_session(&target("weather_agent", "DEFAULT"), "session-one");
        app.push_user_turn("hello from Paris".to_string());
        app.apply(token("Hello from Paris!"));

        app.begin_session(&target("weather_agent", "DEFAULT"), "session-two");

        assert_eq!(app.session, "session-two");
        assert_eq!(app.transcript.len(), 1, "{:?}", app.transcript);
        let marker = &app.transcript[0];
        assert_eq!(marker.role, Role::System);
        assert!(marker.text.contains("new session"), "{}", marker.text);
        assert!(
            !rendered(&app, 70, 12).contains("Paris"),
            "the previous conversation must not survive on screen"
        );
    }

    #[test]
    fn repeated_new_sessions_do_not_accumulate_markers() {
        // Two `/session`s in a row previously left two markers with nothing
        // between them, which is all noise and no information.
        let mut app = App::default();
        app.begin_session(&target("weather_agent", "DEFAULT"), "session-one");
        for id in ["session-two", "session-three", "session-four"] {
            app.begin_session(&target("weather_agent", "DEFAULT"), id);
        }
        assert_eq!(app.transcript.len(), 1, "{:?}", app.transcript);
    }

    #[test]
    fn an_error_in_a_discarded_session_does_not_decide_the_exit_code() {
        // Otherwise a run that hit a model-access error, recovered with
        // `/session`, and then worked perfectly still reports failure.
        let mut app = App::default();
        app.begin_session(&target("weather_agent", "DEFAULT"), "session-one");
        app.apply(AgentEvent::ServerError {
            message: "model access denied".to_string(),
        });
        assert_eq!(
            app.exit_code(),
            ExitCode::from(super::super::exit::AGENT_ERROR)
        );

        app.begin_session(&target("weather_agent", "DEFAULT"), "session-two");
        assert_eq!(app.exit_code(), ExitCode::SUCCESS);
    }

    #[test]
    fn the_first_session_is_not_announced_as_a_replacement() {
        // There is nothing above it to have forgotten.
        let mut app = App::default();
        app.begin_session(&target("weather_agent", "DEFAULT"), "session-one");
        assert!(app.transcript.is_empty(), "{:?}", app.transcript);
        assert_eq!(app.agent, "weather_agent-AbCdEf1234 / DEFAULT");
    }

    #[test]
    fn switching_agents_carries_the_new_target_including_its_version() {
        let mut app = App::default();
        let rows = crate::discovery::selectable_targets(&[
            crate::discovery::RuntimeSummary {
                agent_name: "weather_agent".into(),
                agent_runtime_id: "weather_agent-AbCdEf1234".into(),
                qualifier_to_version: Some(r#"{"DEFAULT":"3"}"#.into()),
                status: Some("Ready".into()),
                architecture_type: Some("SINGLE".into()),
            },
            crate::discovery::RuntimeSummary {
                agent_name: "research_swarm".into(),
                agent_runtime_id: "research_swarm-Zz9988".into(),
                qualifier_to_version: Some(r#"{"DEFAULT":"1"}"#.into()),
                status: Some("Ready".into()),
                architecture_type: Some("SWARM".into()),
            },
        ]);
        app.open_picker(rows);

        app.on_key(key(KeyCode::Down));
        let chosen = app.on_key(key(KeyCode::Enter));

        assert_eq!(
            chosen,
            Action::Switch(Target {
                agent_runtime_id: "research_swarm-Zz9988".into(),
                qualifier: "DEFAULT".into(),
                // Blank here would write an empty version onto the session row.
                runtime_version: "1".into(),
            })
        );
        // The picker closes on selection; leaving it up would swallow the next
        // thing typed.
        assert!(matches!(app.mode, Mode::Chat));
    }

    #[test]
    fn the_picker_can_be_dismissed_and_cannot_run_off_either_end() {
        let mut app = App::default();
        app.open_picker(vec![
            Selectable {
                label: "one".into(),
                target: target("one", "DEFAULT"),
            },
            Selectable {
                label: "two".into(),
                target: target("two", "DEFAULT"),
            },
        ]);

        // Up at the top stays at the top rather than wrapping to the bottom,
        // which would select an agent the user was not looking at.
        app.on_key(key(KeyCode::Up));
        app.on_key(key(KeyCode::Up));
        let Mode::Picker(picker) = &app.mode else {
            panic!("picker closed unexpectedly");
        };
        assert_eq!(picker.selected, 0);

        for _ in 0..5 {
            app.on_key(key(KeyCode::Down));
        }
        let Mode::Picker(picker) = &app.mode else {
            panic!("picker closed unexpectedly");
        };
        assert_eq!(picker.selected, 1);

        // Esc keeps the chat: someone who typed `/agent` by accident is not
        // forced to switch.
        assert_eq!(app.on_key(key(KeyCode::Esc)), Action::Continue);
        assert!(matches!(app.mode, Mode::Chat));
    }

    #[test]
    fn ctrl_c_escapes_the_picker_too() {
        // Otherwise a picker opened over a broken listing would be a trap.
        let mut app = App::default();
        app.open_picker(vec![Selectable {
            label: "one".into(),
            target: target("one", "DEFAULT"),
        }]);
        assert_eq!(
            app.on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Action::Quit
        );
    }

    #[test]
    fn typing_in_the_picker_does_not_reach_the_input_buffer() {
        // The picker owns the keyboard; a character leaking through would appear
        // in the prompt after the picker closed.
        let mut app = App::default();
        app.open_picker(vec![Selectable {
            label: "one".into(),
            target: target("one", "DEFAULT"),
        }]);
        for ch in "hello".chars() {
            app.on_key(key(KeyCode::Char(ch)));
        }
        assert_eq!(app.input, "");
    }

    #[test]
    fn an_empty_agent_list_is_a_notice_rather_than_an_empty_picker() {
        // A picker with no rows and no selection reads as a hang.
        let mut app = App::default();
        app.open_picker(Vec::new());
        assert!(matches!(app.mode, Mode::Chat));
        let Status::Notice(message) = &app.status else {
            panic!("expected a notice, got {:?}", app.status);
        };
        assert!(message.contains("no agent"), "{message}");
    }

    #[test]
    fn enter_while_a_session_is_opening_keeps_what_was_typed() {
        // There is no socket to write to yet, and discarding the line silently is
        // the one outcome with nothing to show for it.
        let mut app = App {
            working: Some("starting a new session".to_string()),
            ..Default::default()
        };
        for ch in "half a question".chars() {
            app.on_key(key(KeyCode::Char(ch)));
        }
        assert_eq!(app.on_key(key(KeyCode::Enter)), Action::Continue);
        assert_eq!(app.input, "half a question");
        assert!(app.transcript.is_empty());
    }

    #[test]
    fn a_reply_still_streaming_cannot_erase_the_opening_indicator() {
        // `/session` typed mid-reply leaves the *old* connection streaming while
        // the new one dials. With the indicator held in `status`, those tokens
        // would overwrite it — the prompt would refuse input with nothing on
        // screen explaining why.
        let mut app = App {
            working: Some("starting a new session".to_string()),
            ..Default::default()
        };
        app.apply(token("the previous answer, still arriving"));

        assert_eq!(app.status, Status::Streaming);
        assert_eq!(app.working.as_deref(), Some("starting a new session"));
        let screen = rendered(&app, 70, 10);
        assert!(screen.contains("starting a new session"), "{screen}");
    }

    #[test]
    fn opening_a_session_clears_the_indicator() {
        let mut app = App {
            working: Some("starting a new session".to_string()),
            ..Default::default()
        };
        app.begin_session(&target("weather_agent", "DEFAULT"), "session-one");
        assert!(app.working.is_none());
        assert_eq!(app.status, Status::Idle);
    }

    #[test]
    fn the_frame_names_the_agent_and_the_session() {
        // Both are needed to correlate a run with CloudWatch, and neither is
        // anywhere else on screen.
        let mut app = App::default();
        app.begin_session(&target("weather_agent", "staging"), "abcdefghij0123456789");
        let screen = rendered(&app, 78, 10);
        assert!(
            screen.contains("weather_agent-AbCdEf1234 / staging"),
            "{screen}"
        );
        assert!(screen.contains("session abcdefghij0123456789"), "{screen}");
    }

    #[test]
    fn the_picker_is_drawn_with_its_selection_and_its_keys() {
        let mut app = App::default();
        app.open_picker(vec![
            Selectable {
                label: "weather_agent / DEFAULT".into(),
                target: target("weather_agent", "DEFAULT"),
            },
            Selectable {
                label: "research_swarm / DEFAULT".into(),
                target: target("research_swarm", "DEFAULT"),
            },
        ]);
        app.on_key(key(KeyCode::Down));

        let screen = rendered(&app, 60, 12);
        assert!(screen.contains("switch agent"), "{screen}");
        assert!(screen.contains("weather_agent / DEFAULT"), "{screen}");
        assert!(screen.contains("research_swarm / DEFAULT"), "{screen}");
        // The highlight marker has to be on the *selected* row, or the list gives
        // no indication of what Enter would do.
        assert!(screen.contains("▸ research_swarm"), "{screen}");
        assert!(screen.contains("esc cancel"), "{screen}");
    }

    #[test]
    fn drawing_the_picker_survives_every_size_too() {
        // Same hazard as the transcript: the pane is where an out-of-range
        // selection would panic behind the alternate screen.
        let mut app = App::default();
        app.open_picker(
            (0..30)
                .map(|index| Selectable {
                    label: format!("agent number {index} with a fairly long label"),
                    target: target(&format!("agent{index}"), "DEFAULT"),
                })
                .collect(),
        );
        for (width, height) in [(80, 24), (80, 5), (20, 4), (10, 3), (4, 2), (1, 1)] {
            for selected in [0_usize, 15, 29] {
                if let Mode::Picker(picker) = &mut app.mode {
                    picker.selected = selected;
                }
                let backend = ratatui::backend::TestBackend::new(width, height);
                let mut terminal = ratatui::Terminal::new(backend).expect("terminal");
                terminal
                    .draw(|frame| draw(frame, &app))
                    .unwrap_or_else(|err| panic!("draw failed at {width}x{height}: {err}"));
            }
        }
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
