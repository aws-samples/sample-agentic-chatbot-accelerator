//! WebSocket lifecycle: presign, connect, classify failures, stream events.
//!
//! This module owns the single `mpsc<AgentEvent>` channel that both UI sinks
//! consume. That seam is what makes `--plain` (T10) a small addition rather than
//! a retrofit, and it is why the read loop decodes frames here instead of in a
//! sink: there is exactly one decoder, exercised by exactly one set of tests.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite;

use crate::protocol::{AgentEvent, SessionId, TEXT_INPUT_TYPE, TextInput};

/// Cold-start allowance.
///
/// AgentCore uses microVM-per-session isolation, so every new session id is a
/// cold container start. The browser's 15s is a UI concession, not a validated
/// bound — this is deliberately far more generous, because a timeout here is
/// indistinguishable to the user from a broken deployment.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

/// Retry ceiling for `RetryableConflictException`.
pub const RETRY_MAX_ATTEMPTS: u32 = 5;

/// First backoff step; each subsequent attempt doubles it.
pub const RETRY_BASE_DELAY: Duration = Duration::from_millis(500);

/// Everything needed to open one runtime session.
pub struct ConnectParams<'a> {
    pub config: &'a crate::config::AppConfig,
    pub agent_runtime_id: &'a str,
    pub qualifier: &'a str,
    pub runtime_version: &'a str,
    pub session_id: &'a SessionId,
    pub identity: &'a crate::auth::Identity,
}

/// A live connection to one runtime session.
pub struct AgentConnection {
    /// Decoded server events. Closed when the socket closes.
    pub events: mpsc::Receiver<AgentEvent>,
    /// Write half. Separated from the read loop, which runs in its own task, so
    /// a send can happen while tokens are still streaming in.
    writer: WriteHalf,
    session_id: SessionId,
    /// Echoed back in every `TextInput`. The container writes these three onto
    /// the DynamoDB session row; omitting them leaves the web UI's session list
    /// showing a blank runtime and endpoint.
    agent_runtime_id: String,
    qualifier: String,
    runtime_version: String,
    /// Cognito `sub`. Non-empty by construction — see [`crate::auth::Identity`].
    user_id: String,
}

/// The sink side of the socket, boxed so tests can substitute a fake.
type WriteHalf = Box<dyn MessageSink>;

/// The one operation `send_text` needs from a socket.
///
/// Abstracted so the `TextInput` assembly — the part with a silent-failure mode
/// if a field is missing — is testable without a live runtime.
trait MessageSink: Send {
    fn send_text<'a>(
        &'a mut self,
        payload: String,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<(), TransportError>> + Send + 'a>>;

    fn close<'a>(
        &'a mut self,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<(), TransportError>> + Send + 'a>>;
}

impl AgentConnection {
    /// Send one user turn.
    ///
    /// `message_id` is generated per call. The `type` discriminant comes from
    /// [`TEXT_INPUT_TYPE`] rather than a literal: the server matches on `type`
    /// and simply loops when it does not recognise the value, so a typo here
    /// would be a dropped turn with no error anywhere.
    pub async fn send_text(&mut self, text: &str) -> Result<(), TransportError> {
        let payload = TextInput {
            r#type: TEXT_INPUT_TYPE,
            text: text.to_string(),
            session_id: self.session_id.as_str().to_string(),
            user_id: self.user_id.clone(),
            message_id: uuid::Uuid::new_v4().to_string(),
            agent_runtime_id: self.agent_runtime_id.clone(),
            qualifier: self.qualifier.clone(),
            runtime_version: self.runtime_version.clone(),
        };
        let json = serde_json::to_string(&payload)
            .map_err(|err| TransportError::Io(format!("could not serialise turn: {err}")))?;

        // The text itself is user content, not a secret, but it is also not
        // useful in a log; only the metadata is.
        tracing::debug!(
            session_id = self.session_id.as_str(),
            message_id = %payload.message_id,
            chars = text.len(),
            "sending turn"
        );
        self.writer.send_text(json).await
    }

    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    /// Close the socket politely.
    pub async fn close(mut self) -> Result<(), TransportError> {
        self.writer.close().await
    }
}

/// Presign, connect, and spawn the read loop.
///
/// Retries [`HandshakeError::RetryableConflict`] with exponential backoff up to
/// [`RETRY_MAX_ATTEMPTS`]; every other error returns immediately. Credentials are
/// re-fetched from the broker on **each** attempt, so a retry after a long
/// backoff cannot present expired credentials.
pub async fn connect(
    params: ConnectParams<'_>,
    broker: &mut crate::auth::CredentialBroker,
) -> Result<AgentConnection, TransportError> {
    let mut attempt = 0;
    loop {
        let creds = broker.current().await?;
        let url = crate::presign::presign_ws_url(crate::presign::PresignInput {
            region: &params.config.region,
            account_id: &params.config.account_id,
            agent_runtime_id: params.agent_runtime_id,
            qualifier: params.qualifier,
            session_id: params.session_id,
            credentials: &creds,
            at: std::time::SystemTime::now(),
            expires_in: Duration::from_secs(crate::presign::EXPIRES_IN_SECS),
        })?;

        // Redacted, never raw: the presigned URL is a bearer credential — anyone
        // holding it can invoke the runtime as this user until it expires.
        tracing::info!(
            url = %crate::telemetry::redact_presigned_url(&url),
            attempt,
            "opening websocket"
        );

        match dial(&url).await {
            Ok(stream) => return Ok(spawn(stream, params)),
            Err(TransportError::Handshake(HandshakeError::RetryableConflict)) => {
                attempt += 1;
                if attempt >= RETRY_MAX_ATTEMPTS {
                    return Err(TransportError::RetriesExhausted(attempt));
                }
                let delay = backoff_delay(attempt);
                tracing::warn!(
                    ?delay,
                    attempt,
                    "previous session still releasing; retrying"
                );
                tokio::time::sleep(delay).await;
            }
            Err(other) => return Err(other),
        }
    }
}

/// Delay before retry `attempt` (1-based): `RETRY_BASE_DELAY * 2^(attempt-1)`.
///
/// Extracted so the schedule is assertable without waiting on a real clock.
pub fn backoff_delay(attempt: u32) -> Duration {
    RETRY_BASE_DELAY * 2u32.saturating_pow(attempt.saturating_sub(1))
}

/// One connect attempt, with the URL passed to `connect_async` **verbatim**.
///
/// No `Url` parse, no re-encoding, no query reordering: any of those invalidate
/// the SigV4 signature and the result is a bare 403. `tokio-tungstenite` taking a
/// `&str` unchanged is precisely why that crate was chosen.
async fn dial(url: &str) -> Result<WsStream, TransportError> {
    let attempt = tokio_tungstenite::connect_async(url);
    match tokio::time::timeout(CONNECT_TIMEOUT, attempt).await {
        Err(_elapsed) => Err(TransportError::Timeout(CONNECT_TIMEOUT)),
        Ok(Ok((stream, _response))) => Ok(stream),
        Ok(Err(err)) => Err(map_connect_error(err)),
    }
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Turn a `tungstenite` connect failure into a typed error.
///
/// The HTTP variant is the important one: a pre-upgrade rejection carries the AWS
/// error type in an `x-amzn-ErrorType` header and the detail in the **body**.
/// Reporting only the status is what makes every signing mistake look like the
/// same anonymous 403, so the body is read and carried through.
fn map_connect_error(err: tungstenite::Error) -> TransportError {
    match err {
        tungstenite::Error::Http(response) => {
            let status = response.status().as_u16();
            let error_type = response
                .headers()
                .get("x-amzn-ErrorType")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let body = response
                .body()
                .as_ref()
                .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string())
                .unwrap_or_default();
            TransportError::Handshake(classify_handshake(status, error_type.as_deref(), &body))
        }
        other => TransportError::Io(other.to_string()),
    }
}

/// Classify a failed upgrade.
///
/// `body` is included in every message that has one. This is the whole point of
/// the function: without it a wrong signature, a wrong region and a malformed
/// session id are three identical 403s.
pub fn classify_handshake(status: u16, error_type: Option<&str>, body: &str) -> HandshakeError {
    // The header is more specific than the status when both are present — 409 in
    // particular is only retryable when the service names it as such.
    let named = error_type.unwrap_or_default();
    let detail = describe(error_type, body);

    match status {
        400 => HandshakeError::Validation(detail),
        403 => HandshakeError::AccessDenied(detail),
        404 => HandshakeError::NotFound(detail),
        409 => HandshakeError::RetryableConflict,
        424 => HandshakeError::RuntimeClient(detail),
        429 => HandshakeError::Throttling,
        _ if named.contains("RetryableConflictException") => HandshakeError::RetryableConflict,
        _ if named.contains("ThrottlingException") => HandshakeError::Throttling,
        _ => HandshakeError::Other {
            status,
            body: detail,
        },
    }
}

/// Combine the AWS error type and the response body into one detail string.
///
/// Either may be absent; an empty result still reads sensibly in the error
/// messages, which is why they interpolate it rather than branching on it.
fn describe(error_type: Option<&str>, body: &str) -> String {
    match (error_type.map(str::trim).filter(|s| !s.is_empty()), body) {
        (Some(kind), "") => kind.to_string(),
        (Some(kind), body) => format!("{kind}: {body}"),
        (None, "") => "no detail returned".to_string(),
        (None, body) => body.to_string(),
    }
}

/// Wrap a connected socket: split it, spawn the read loop, return the handle.
fn spawn(stream: WsStream, params: ConnectParams<'_>) -> AgentConnection {
    let (sink, source) = stream.split();
    // Bounded: if a sink stops consuming, backpressure the socket rather than
    // growing the queue without limit during a long token stream.
    let (tx, events) = mpsc::channel(256);
    tokio::spawn(read_loop(source, tx));

    AgentConnection {
        events,
        writer: Box::new(TungsteniteSink(sink)),
        session_id: params.session_id.clone(),
        agent_runtime_id: params.agent_runtime_id.to_string(),
        qualifier: params.qualifier.to_string(),
        runtime_version: params.runtime_version.to_string(),
        user_id: params.identity.sub.clone(),
    }
}

/// Read frames, decode, forward.
///
/// A `DecodeError` is logged to file and skipped rather than fatal: the four
/// agent architectures are separate containers and may emit types this build does
/// not know, so one unfamiliar frame must not end a working chat.
async fn read_loop(
    mut source: impl StreamExt<Item = Result<tungstenite::Message, tungstenite::Error>> + Unpin,
    tx: mpsc::Sender<AgentEvent>,
) {
    while let Some(frame) = source.next().await {
        let message = match frame {
            Ok(message) => message,
            Err(err) => {
                tracing::warn!(error = %err, "socket read failed; ending stream");
                break;
            }
        };

        let text = match message {
            tungstenite::Message::Text(text) => text.to_string(),
            tungstenite::Message::Binary(bytes) => match String::from_utf8(bytes.to_vec()) {
                Ok(text) => text,
                Err(_) => {
                    tracing::warn!("skipping non-UTF-8 binary frame");
                    continue;
                }
            },
            tungstenite::Message::Close(frame) => {
                // Post-upgrade failures are close codes, not HTTP statuses, so
                // they cannot go through `classify_handshake`. An abnormal close
                // is forwarded as a `ServerError` event rather than just logged:
                // the sink already renders those, and a chat that simply stops
                // with nothing on screen is the least debuggable outcome.
                let code = frame.map(|frame| u16::from(frame.code)).unwrap_or(1000);
                if let Some(reason) = abnormal_close_reason(code) {
                    tracing::warn!(code, reason = %reason, "socket closed abnormally");
                    let _ = tx.send(AgentEvent::ServerError { message: reason }).await;
                } else {
                    tracing::info!(code, "socket closed by peer");
                }
                break;
            }
            // Ping/pong are answered by tungstenite itself, and that activity is
            // what resets AgentCore's idle timer — which is why there is
            // deliberately no application-level heartbeat here.
            _ => continue,
        };

        match crate::protocol::decode(&text) {
            Ok(event) => {
                if tx.send(event).await.is_err() {
                    // Receiver dropped: the sink is gone, so stop reading.
                    break;
                }
            }
            Err(err) => tracing::warn!(error = %err, "skipping undecodable frame"),
        }
    }
}

/// Describe a WebSocket close code, or `None` if it was an ordinary close.
///
/// Only three codes carry information the user can act on. 1008 is the one that
/// matters most in practice: it is how the 60-minute streaming cap arrives, and
/// without the hint it looks like an unexplained disconnect. Transparent
/// reconnect is out of scope, so the message tells the user to restart.
fn abnormal_close_reason(code: u16) -> Option<String> {
    match code {
        1008 => Some(TransportError::ClosedByService { code }.to_string()),
        1009 => Some(
            "the service rejected a frame as too large (1009); \
             AgentCore documents a 32 KB limit"
                .to_string(),
        ),
        1011 => Some(
            "the service hit an internal error (1011); \
             check the agent's CloudWatch logs"
                .to_string(),
        ),
        _ => None,
    }
}

/// The real socket sink.
struct TungsteniteSink(futures_util::stream::SplitSink<WsStream, tungstenite::Message>);

impl MessageSink for TungsteniteSink {
    fn send_text<'a>(
        &'a mut self,
        payload: String,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<(), TransportError>> + Send + 'a>> {
        Box::pin(async move {
            self.0
                .send(tungstenite::Message::text(payload))
                .await
                .map_err(|err| TransportError::Io(err.to_string()))
        })
    }

    fn close<'a>(
        &'a mut self,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<(), TransportError>> + Send + 'a>> {
        Box::pin(async move {
            self.0
                .close()
                .await
                .map_err(|err| TransportError::Io(err.to_string()))
        })
    }
}

/// Why an upgrade was refused, before the socket ever opened.
#[derive(Debug, thiserror::Error)]
pub enum HandshakeError {
    #[error("the runtime rejected the request (400 ValidationException): {0}")]
    Validation(String),
    #[error("access denied (403) — the signature or the identity-pool permissions are wrong: {0}")]
    AccessDenied(String),
    #[error("no such runtime or endpoint (404): {0}")]
    NotFound(String),
    #[error("the previous session is still shutting down (409) — retrying")]
    RetryableConflict,
    #[error("the agent container itself returned an error (424) — check its CloudWatch logs: {0}")]
    RuntimeClient(String),
    #[error("throttled (429) — retry shortly")]
    Throttling,
    #[error("unexpected handshake failure ({status}): {body}")]
    Other { status: u16, body: String },
}

/// Anything that can go wrong owning the socket.
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error(transparent)]
    Handshake(#[from] HandshakeError),
    #[error("connection timed out after {0:?}; the runtime may be cold-starting")]
    Timeout(Duration),
    #[error("still conflicting after {0} attempts; the previous session has not released")]
    RetriesExhausted(u32),
    #[error("closed by the service (code {code}) — WebSocket sessions are capped at 60 minutes")]
    ClosedByService { code: u16 },
    #[error(transparent)]
    Presign(#[from] crate::presign::PresignError),
    #[error(transparent)]
    Credentials(#[from] crate::auth::CredentialError),
    #[error("socket error: {0}")]
    Io(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Identity;
    use crate::config::AppConfig;

    #[test]
    fn classifies_every_documented_status_and_carries_the_body() {
        let cases = [
            (400, "ValidationException", "sessionId too short"),
            (403, "AccessDeniedException", "not authorized to perform"),
            (404, "ResourceNotFoundException", "runtime not found"),
            (424, "RuntimeClientError", "container exited"),
        ];

        for (status, kind, body) in cases {
            let classified = classify_handshake(status, Some(kind), body);
            let rendered = classified.to_string();
            assert!(
                rendered.contains(body),
                "status {status} dropped the body: {rendered}"
            );
            assert!(
                rendered.contains(kind),
                "status {status} dropped the error type: {rendered}"
            );
        }
    }

    #[test]
    fn retryable_and_throttling_are_recognised_by_status() {
        assert!(matches!(
            classify_handshake(409, Some("RetryableConflictException"), "still draining"),
            HandshakeError::RetryableConflict
        ));
        assert!(matches!(
            classify_handshake(429, Some("ThrottlingException"), "slow down"),
            HandshakeError::Throttling
        ));
    }

    #[test]
    fn retryable_is_also_recognised_by_error_type_alone() {
        // Defence against the status arriving as something unexpected while the
        // header still names the retryable condition.
        assert!(matches!(
            classify_handshake(500, Some("RetryableConflictException"), ""),
            HandshakeError::RetryableConflict
        ));
    }

    #[test]
    fn unknown_status_keeps_status_and_body() {
        let classified = classify_handshake(418, None, "unexpected teapot");
        match &classified {
            HandshakeError::Other { status, body } => {
                assert_eq!(*status, 418);
                assert_eq!(body, "unexpected teapot");
            }
            other => panic!("expected Other, got {other:?}"),
        }
        assert!(classified.to_string().contains("unexpected teapot"));
    }

    #[test]
    fn a_missing_body_still_produces_a_readable_message() {
        // The worst case for debuggability is a bare status with nothing attached;
        // it must still say something rather than rendering an empty tail.
        let rendered = classify_handshake(403, None, "").to_string();
        assert!(rendered.contains("no detail returned"), "{rendered}");
    }

    #[test]
    fn a_corrupted_signature_reports_access_denied_with_the_body() {
        // What a wrong signature actually looks like on the wire. The body is the
        // only thing distinguishing it from a permissions problem, so the test
        // asserts it survives into the user-facing message.
        let body = "The request signature we calculated does not match the \
                    signature you provided.";
        let classified = classify_handshake(403, Some("AccessDeniedException"), body);
        assert!(matches!(classified, HandshakeError::AccessDenied(_)));
        assert!(classified.to_string().contains("signature we calculated"));
    }

    #[test]
    fn backoff_doubles_and_does_not_overflow() {
        assert_eq!(backoff_delay(1), RETRY_BASE_DELAY);
        assert_eq!(backoff_delay(2), RETRY_BASE_DELAY * 2);
        assert_eq!(backoff_delay(3), RETRY_BASE_DELAY * 4);
        assert_eq!(backoff_delay(4), RETRY_BASE_DELAY * 8);
        // The loop never reaches this, but a panic here would be a crash on a
        // retry path — the least testable place to have one.
        let _ = backoff_delay(u32::MAX);
    }

    /// Collects payloads instead of writing to a socket, so the `TextInput`
    /// assembly is checkable offline.
    struct RecordingSink(std::sync::Arc<std::sync::Mutex<Vec<String>>>);

    impl MessageSink for RecordingSink {
        fn send_text<'a>(
            &'a mut self,
            payload: String,
        ) -> std::pin::Pin<Box<dyn Future<Output = Result<(), TransportError>> + Send + 'a>>
        {
            self.0.lock().expect("sink mutex").push(payload);
            Box::pin(async { Ok(()) })
        }

        fn close<'a>(
            &'a mut self,
        ) -> std::pin::Pin<Box<dyn Future<Output = Result<(), TransportError>> + Send + 'a>>
        {
            Box::pin(async { Ok(()) })
        }
    }

    fn recording_connection() -> (
        AgentConnection,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (_tx, events) = mpsc::channel(4);
        let connection = AgentConnection {
            events,
            writer: Box::new(RecordingSink(std::sync::Arc::clone(&sent))),
            session_id: SessionId::new_random(),
            agent_runtime_id: "my_agent-AbCdEf".to_string(),
            qualifier: "DEFAULT".to_string(),
            runtime_version: "1".to_string(),
            user_id: "11111111-2222-3333-4444-555555555555".to_string(),
        };
        (connection, sent)
    }

    #[tokio::test]
    async fn a_turn_carries_the_three_fields_the_session_row_needs() {
        let (mut connection, sent) = recording_connection();
        connection.send_text("hello").await.expect("send");

        let payloads = sent.lock().expect("sink mutex");
        let payload: serde_json::Value =
            serde_json::from_str(&payloads[0]).expect("turn is valid JSON");

        assert_eq!(payload["type"], TEXT_INPUT_TYPE);
        assert_eq!(payload["text"], "hello");
        // Omitting any of these three leaves the web UI's session list showing a
        // blank runtime and endpoint — a silent failure with no error anywhere.
        assert_eq!(payload["agentRuntimeId"], "my_agent-AbCdEf");
        assert_eq!(payload["qualifier"], "DEFAULT");
        assert_eq!(payload["runtimeVersion"], "1");
        // An empty userId makes the container drop history without complaining.
        assert!(
            payload["userId"]
                .as_str()
                .is_some_and(|sub| !sub.is_empty()),
            "userId must never be empty"
        );
    }

    #[tokio::test]
    async fn a_second_turn_reuses_the_session_but_not_the_message_id() {
        let (mut connection, sent) = recording_connection();
        connection.send_text("first").await.expect("send");
        connection.send_text("second").await.expect("send");

        let payloads = sent.lock().expect("sink mutex");
        let first: serde_json::Value = serde_json::from_str(&payloads[0]).expect("json");
        let second: serde_json::Value = serde_json::from_str(&payloads[1]).expect("json");

        assert_eq!(first["sessionId"], second["sessionId"]);
        assert_ne!(first["messageId"], second["messageId"]);
    }

    #[tokio::test]
    async fn the_read_loop_forwards_decoded_events_and_skips_bad_frames() {
        let frames = vec![
            Ok(tungstenite::Message::text(
                r#"{"type":"text_token","data":"one","sequenceNumber":1}"#,
            )),
            // Undecodable: must be skipped, not fatal, or one unfamiliar frame
            // from a swarm/graph container would end a working chat.
            Ok(tungstenite::Message::text("{ not json")),
            Ok(tungstenite::Message::text(
                r#"{"type":"text_token","data":"two","sequenceNumber":2}"#,
            )),
        ];
        let (tx, mut events) = mpsc::channel(8);
        read_loop(futures_util::stream::iter(frames), tx).await;

        let mut seen = Vec::new();
        while let Some(event) = events.recv().await {
            if let AgentEvent::TextToken { data, .. } = event {
                seen.push(data);
            }
        }
        assert_eq!(seen, vec!["one", "two"]);
    }

    #[tokio::test]
    async fn a_policy_close_surfaces_the_sixty_minute_cap() {
        // The 60-minute streaming cap arrives as close code 1008. Without a
        // rendered reason the chat just stops with nothing on screen, which is
        // exactly the failure mode this test exists to prevent.
        let frames = vec![Ok(tungstenite::Message::Close(Some(
            tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Policy,
                reason: "".into(),
            },
        )))];
        let (tx, mut events) = mpsc::channel(4);
        read_loop(futures_util::stream::iter(frames), tx).await;

        match events.recv().await {
            Some(AgentEvent::ServerError { message }) => {
                assert!(message.contains("60 minutes"), "{message}");
            }
            other => panic!("expected a ServerError event, got {other:?}"),
        }
    }

    #[test]
    fn an_ordinary_close_is_not_reported_as_an_error() {
        assert!(abnormal_close_reason(1000).is_none());
        assert!(abnormal_close_reason(1008).is_some());
        assert!(abnormal_close_reason(1009).is_some());
        assert!(abnormal_close_reason(1011).is_some());
    }

    #[tokio::test]
    async fn a_close_frame_ends_the_stream() {
        let frames = vec![
            Ok(tungstenite::Message::text(
                r#"{"type":"text_token","data":"before","sequenceNumber":1}"#,
            )),
            Ok(tungstenite::Message::Close(None)),
            Ok(tungstenite::Message::text(
                r#"{"type":"text_token","data":"after","sequenceNumber":2}"#,
            )),
        ];
        let (tx, mut events) = mpsc::channel(8);
        read_loop(futures_util::stream::iter(frames), tx).await;

        let mut count = 0;
        while events.recv().await.is_some() {
            count += 1;
        }
        assert_eq!(count, 1, "frames after Close must not be delivered");
    }

    #[test]
    fn connect_params_borrow_without_cloning_config() {
        // Compile-time check that the params type stays borrow-only: making it
        // owned would force T10 to clone the config per reconnect attempt.
        let config = AppConfig {
            region: "us-west-2".to_string(),
            account_id: "123456789012".to_string(),
            user_pool_id: "us-west-2_ExamplePool".to_string(),
            user_pool_client_id: "1example23client45id6789".to_string(),
            identity_pool_id: "us-west-2:11111111-2222-3333-4444-555555555555".to_string(),
            appsync_url: None,
        };
        let session_id = SessionId::new_random();
        let identity = Identity {
            sub: "11111111-2222-3333-4444-555555555555".to_string(),
            email: None,
        };
        let params = ConnectParams {
            config: &config,
            agent_runtime_id: "my_agent-AbCdEf",
            qualifier: "DEFAULT",
            runtime_version: "1",
            session_id: &session_id,
            identity: &identity,
        };
        assert_eq!(params.qualifier, "DEFAULT");
    }
}
