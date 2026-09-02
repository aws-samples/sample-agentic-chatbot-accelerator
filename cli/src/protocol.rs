//! The `/ws` wire contract: session ids, the outbound turn, inbound events.
//!
//! Pure by design — no IO, no clock, no globals — because two of this story's
//! silent-failure traps live here and can only be defended by offline tests:
//!
//! 1. A session id shorter than 33 characters is rejected by AgentCore with a
//!    bare 400 that looks exactly like every other handshake failure, so
//!    [`SessionId`] refuses to construct one.
//! 2. The four agent architectures are *separate containers* (`docker/`,
//!    `docker-agents-as-tools/`, `docker-swarm/`, `docker-graph/`) whose event
//!    sets are only partly verified, so [`decode`] is total over well-formed
//!    JSON: an unfamiliar `type` becomes [`AgentEvent::Unknown`] instead of
//!    killing a live chat.
//!
//! The authoritative server side is the `/ws` handler in
//! `src/agent-core/docker/app.py` plus the shared emitters in
//! `src/agent-core/shared/base_callbacks.py`; the closest reference client is
//! the browser's event switch in
//! `src/user-interface/react-app/src/websocket-presigned.ts`.

use serde_json::Value;

/// Documented minimum for `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`
/// (min 33, max 256 per the InvokeAgentRuntime API reference).
pub const MIN_SESSION_ID_LEN: usize = 33;

/// Documented maximum for `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`.
pub const MAX_SESSION_ID_LEN: usize = 256;

/// A runtime session id known to satisfy AgentCore's length constraint.
///
/// Exists as a newtype specifically because a 32-character id — what
/// `Uuid::new_v4().simple()` produces — is rejected by the service with an
/// opaque 400 that looks identical to every other handshake failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionId(String);

impl SessionId {
    /// Generate a fresh hyphenated UUIDv4 (36 chars — safely above the minimum).
    ///
    /// MUST stay hyphenated. Do not "tidy" this into `.simple()`: the hyphens
    /// are the only thing carrying the id from 32 characters to 36, i.e. from
    /// "rejected with an opaque 400" to "accepted".
    pub fn new_random() -> Self {
        Self(uuid::Uuid::new_v4().hyphenated().to_string())
    }

    /// Validate a caller-supplied id (e.g. `--session-id`).
    ///
    /// Errors with an actionable message naming the actual and required
    /// lengths, so a user passing `test-1` learns why rather than seeing a 400.
    ///
    /// Length is counted in `char`s rather than bytes: a user who pasted an id
    /// containing a multi-byte character should be told the same number they
    /// can count on screen, and the constraint is documented in characters.
    pub fn parse(raw: impl Into<String>) -> Result<Self, SessionIdError> {
        let raw = raw.into();
        let got = raw.chars().count();
        if got < MIN_SESSION_ID_LEN {
            return Err(SessionIdError::TooShort { got });
        }
        if got > MAX_SESSION_ID_LEN {
            return Err(SessionIdError::TooLong { got });
        }
        Ok(Self(raw))
    }

    /// Borrow the id for the presign query string and the outbound payload.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Why a caller-supplied session id cannot be used.
#[derive(Debug, thiserror::Error)]
pub enum SessionIdError {
    #[error(
        "session id must be at least {MIN_SESSION_ID_LEN} characters (got {got}); AgentCore rejects shorter ids with an opaque 400"
    )]
    TooShort { got: usize },
    #[error("session id must be at most {MAX_SESSION_ID_LEN} characters (got {got})")]
    TooLong { got: usize },
}

/// One user turn, serialised as the container's `/ws` handler expects.
///
/// `agent_runtime_id`, `qualifier` and `runtime_version` are **not optional in
/// practice**: the container writes them onto the DynamoDB session row
/// (`save_conversation_exchange`), and omitting them makes the web UI's session
/// list show blank runtime/endpoint for anything this CLI said.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextInput {
    /// Always the literal `"text_input"`.
    pub r#type: &'static str,
    pub text: String,
    pub session_id: String,
    /// Cognito `sub`. MUST be non-empty — see T7. The container defaults it to
    /// `""` and then silently stores history nobody can read back.
    pub user_id: String,
    pub message_id: String,
    pub agent_runtime_id: String,
    pub qualifier: String,
    pub runtime_version: String,
}

/// The `type` discriminant of an outbound turn.
///
/// Named so the literal appears exactly once in the crate — `r#type` on
/// [`TextInput`] is a `&'static str` precisely so it cannot be typo'd per
/// call site, and a typo here would be a silently ignored frame: the server
/// matches on `type` and simply loops when it does not recognise the value.
pub const TEXT_INPUT_TYPE: &str = "text_input";

/// Anything the server can send us, plus a catch-all.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    /// Streaming token delta — the MVP's primary render path.
    TextToken {
        data: String,
        sequence_number: i64,
        run_id: Option<String>,
    },
    /// A tool step began.
    ToolAction {
        tool_name: String,
        description: Option<String>,
        invocation_number: i64,
        parameters: Vec<ToolParameter>,
    },
    /// A tool step ended. `status` is `"success"` when absent.
    ToolComplete {
        tool_name: String,
        invocation_number: i64,
        status: String,
    },
    /// End of turn.
    FinalResponse(FinalResponse),
    /// Server-reported application error (not a transport failure).
    ServerError { message: String },
    /// Response to a heartbeat we did not send; ignorable.
    ///
    /// Kept as a variant rather than dropped into [`AgentEvent::Unknown`] so a
    /// future reader can see the frame is expected and deliberately inert — the
    /// transport relies on WebSocket ping/pong, not an application heartbeat.
    HeartbeatAck,
    /// A `type` this build does not know. Retained, never fatal: the four agent
    /// architectures are separate containers and may add event types.
    ///
    /// Every voice event (`bidi_*`, `tool_use_stream`, `tool_result`, …) lands
    /// here on purpose — voice is out of scope, and a variant per voice frame
    /// would imply support this client does not have.
    Unknown { r#type: String },
}

/// One argument the agent passed to a tool, already rendered for display.
///
/// `value` is a string because the server has already JSON-encoded and
/// length-capped it (`_format_arg_value`); this is a preview, not the payload.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolParameter {
    pub name: String,
    pub value: String,
}

/// The end-of-turn frame.
///
/// The three optional fields arrive only when the agent produced them, and the
/// MVP displays them raw at most. They are carried rather than dropped so a
/// later task does not have to revisit the decoder to surface them.
#[derive(Debug, Clone, PartialEq)]
pub struct FinalResponse {
    pub content: String,
    pub session_id: String,
    pub message_id: String,
    pub references: Option<String>,
    pub reasoning_content: Option<String>,
    pub structured_output: Option<String>,
}

/// Decode one text frame.
///
/// Total over well-formed JSON: an unrecognised `type` yields
/// [`AgentEvent::Unknown`] rather than an error. Only malformed JSON, a missing
/// or non-string `type`, or a known type missing the one field that gives it
/// meaning is an error.
///
/// Fields that merely *decorate* a known event (`sequenceNumber`,
/// `invocationNumber`, `status`, `sessionId`, `messageId`) fall back to a
/// default instead of failing. That asymmetry is deliberate: `docker-swarm/`
/// and `docker-graph/` reuse this contract without re-emitting every field, and
/// a missing sequence number is not worth ending a conversation over when the
/// MVP renders tokens in arrival order anyway.
pub fn decode(raw: &str) -> Result<AgentEvent, DecodeError> {
    let frame: Value = serde_json::from_str(raw)?;
    let r#type = frame
        .get("type")
        .and_then(Value::as_str)
        .ok_or(DecodeError::MissingType)?;

    match r#type {
        "text_token" => Ok(AgentEvent::TextToken {
            data: required_str(&frame, r#type, "data")?,
            sequence_number: i64_or_zero(&frame, "sequenceNumber"),
            run_id: optional_str(&frame, "runId"),
        }),
        "tool_action" => Ok(AgentEvent::ToolAction {
            tool_name: required_str(&frame, r#type, "toolName")?,
            // Empty is treated as absent: the server sends `""` when a tool has
            // no spec description, and rendering "using X: " with a dangling
            // colon is worse than rendering nothing.
            description: optional_str(&frame, "description").filter(|text| !text.is_empty()),
            invocation_number: i64_or_zero(&frame, "invocationNumber"),
            parameters: tool_parameters(&frame),
        }),
        "tool_complete" => Ok(AgentEvent::ToolComplete {
            tool_name: required_str(&frame, r#type, "toolName")?,
            invocation_number: i64_or_zero(&frame, "invocationNumber"),
            // Mirrors the browser's `data.status || "success"`.
            status: optional_str(&frame, "status")
                .filter(|status| !status.is_empty())
                .unwrap_or_else(|| DEFAULT_TOOL_STATUS.to_string()),
        }),
        "final_response" => Ok(AgentEvent::FinalResponse(FinalResponse {
            content: required_str(&frame, r#type, "content")?,
            session_id: optional_str(&frame, "sessionId").unwrap_or_default(),
            message_id: optional_str(&frame, "messageId").unwrap_or_default(),
            references: optional_str(&frame, "references"),
            reasoning_content: optional_str(&frame, "reasoningContent"),
            structured_output: optional_str(&frame, "structuredOutput"),
        })),
        "error" => Ok(AgentEvent::ServerError {
            message: required_str(&frame, r#type, "message")?,
        }),
        "heartbeat_ack" => Ok(AgentEvent::HeartbeatAck),
        other => Ok(AgentEvent::Unknown {
            r#type: other.to_string(),
        }),
    }
}

/// Status assumed when `tool_complete` omits one, matching the browser.
const DEFAULT_TOOL_STATUS: &str = "success";

/// Read a string field that the event cannot be interpreted without.
fn required_str(frame: &Value, r#type: &str, field: &str) -> Result<String, DecodeError> {
    frame
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| DecodeError::MissingField {
            r#type: r#type.to_string(),
            field: field.to_string(),
        })
}

/// Read an optional string field, treating a non-string value as absent.
///
/// Coercing (say) a number to its digits would invent data the server did not
/// send; for every field read this way, absent and unusable are equivalent.
fn optional_str(frame: &Value, field: &str) -> Option<String> {
    frame.get(field).and_then(Value::as_str).map(str::to_string)
}

/// Read a counter, defaulting to zero.
///
/// Zero is safe for the one thing counters are used for — pairing a
/// `tool_action` with its `tool_complete` — because a container that omits the
/// field omits it on both halves, so the pair still correlates.
fn i64_or_zero(frame: &Value, field: &str) -> i64 {
    frame.get(field).and_then(Value::as_i64).unwrap_or_default()
}

/// Extract `parameters`, skipping entries with no usable `name`.
///
/// A non-string `value` is rendered as compact JSON rather than dropped: the
/// field exists to show the user what the agent passed, and showing `[1,2]` is
/// strictly better than showing the argument as if it had been absent.
fn tool_parameters(frame: &Value) -> Vec<ToolParameter> {
    let Some(entries) = frame.get("parameters").and_then(Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let name = entry.get("name").and_then(Value::as_str)?;
            let value = match entry.get("value") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            Some(ToolParameter {
                name: name.to_string(),
                value,
            })
        })
        .collect()
}

/// Why a server frame could not be turned into an [`AgentEvent`].
///
/// Note what is *not* here: an "unknown type" variant. That is the point.
#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("frame is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("frame has no `type` field")]
    MissingType,
    // `{type}`, not `{r#type}`: format strings take the plain identifier even
    // when the field needs the raw prefix in Rust source.
    #[error("frame of type `{type}` is missing required field `{field}`")]
    MissingField { r#type: String, field: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 36-char hyphenated UUID — the shape `new_random` produces.
    const HYPHENATED_UUID: &str = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    /// The same value with hyphens stripped: 32 chars, i.e. what
    /// `Uuid::simple()` yields and what the service rejects.
    const SIMPLE_UUID: &str = "6ba7b8109dad11d180b400c04fd430c8";

    #[test]
    fn new_random_clears_the_documented_minimum() {
        for _ in 0..64 {
            let id = SessionId::new_random();
            assert!(
                id.as_str().chars().count() >= MIN_SESSION_ID_LEN,
                "generated {id:?} is below the minimum"
            );
            // The hyphens are the whole margin; assert them, not just the length.
            assert_eq!(
                id.as_str().matches('-').count(),
                4,
                "not hyphenated: {id:?}"
            );
        }
    }

    #[test]
    fn parse_rejects_a_32_char_simple_uuid() {
        assert_eq!(SIMPLE_UUID.len(), 32);
        let err = SessionId::parse(SIMPLE_UUID).expect_err("32 chars must be rejected");
        assert!(matches!(err, SessionIdError::TooShort { got: 32 }));
        // The message has to name both numbers or the user cannot act on it.
        let rendered = err.to_string();
        assert!(rendered.contains("33"), "{rendered}");
        assert!(rendered.contains("32"), "{rendered}");
    }

    #[test]
    fn parse_accepts_a_36_char_hyphenated_uuid() {
        let id = SessionId::parse(HYPHENATED_UUID).expect("36 chars must be accepted");
        assert_eq!(id.as_str(), HYPHENATED_UUID);
    }

    #[test]
    fn parse_boundaries_are_inclusive() {
        let at_min = "x".repeat(MIN_SESSION_ID_LEN);
        assert!(SessionId::parse(&at_min).is_ok());
        assert!(SessionId::parse("x".repeat(MIN_SESSION_ID_LEN - 1)).is_err());

        let at_max = "x".repeat(MAX_SESSION_ID_LEN);
        assert!(SessionId::parse(&at_max).is_ok());
        let err = SessionId::parse("x".repeat(MAX_SESSION_ID_LEN + 1))
            .expect_err("over the maximum must be rejected");
        assert!(matches!(err, SessionIdError::TooLong { got: 257 }));
    }

    #[test]
    fn parse_counts_characters_not_bytes() {
        // 12 chars, 36 bytes. Counting bytes would wrongly accept this.
        let short_but_fat = "字".repeat(12);
        assert!(short_but_fat.len() > MIN_SESSION_ID_LEN);
        assert!(SessionId::parse(&short_but_fat).is_err());
    }

    #[test]
    fn text_input_serialises_the_fields_the_session_row_needs() {
        let input = TextInput {
            r#type: TEXT_INPUT_TYPE,
            text: "hello".into(),
            session_id: HYPHENATED_UUID.into(),
            user_id: "c1f2e3d4-user-sub".into(),
            message_id: "msg-1".into(),
            agent_runtime_id: "my_agent-AbCdEf".into(),
            qualifier: "DEFAULT".into(),
            runtime_version: "3".into(),
        };

        let json: Value = serde_json::to_value(&input).expect("serialise");
        // camelCase, and every key the container reads.
        assert_eq!(json["type"], "text_input");
        assert_eq!(json["text"], "hello");
        assert_eq!(json["sessionId"], HYPHENATED_UUID);
        assert_eq!(json["userId"], "c1f2e3d4-user-sub");
        assert_eq!(json["messageId"], "msg-1");
        assert_eq!(json["agentRuntimeId"], "my_agent-AbCdEf");
        assert_eq!(json["qualifier"], "DEFAULT");
        assert_eq!(json["runtimeVersion"], "3");

        // No snake_case leakage: the container matches exact key names and
        // silently ignores anything else, so a rename here loses history.
        let object = json.as_object().expect("object");
        for stray in [
            "session_id",
            "user_id",
            "agent_runtime_id",
            "runtime_version",
        ] {
            assert!(!object.contains_key(stray), "{stray} leaked");
        }
        assert_eq!(object.len(), 8, "unexpected key set: {object:?}");
    }

    /// Every `type` in the story's contract table, in the exact shape the
    /// containers emit (see `app.py` and `shared/base_callbacks.py`).
    #[test]
    fn decodes_every_type_in_the_contract() {
        let cases: Vec<(&str, AgentEvent)> = vec![
            (
                r#"{"type":"text_token","data":"Hey","sequenceNumber":7,"runId":"t-abc"}"#,
                AgentEvent::TextToken {
                    data: "Hey".into(),
                    sequence_number: 7,
                    run_id: Some("t-abc".into()),
                },
            ),
            (
                r#"{"type":"tool_action","toolName":"retrieve","description":"Search the KB",
                    "parameters":[{"name":"query","value":"rust"}],"invocationNumber":2}"#,
                AgentEvent::ToolAction {
                    tool_name: "retrieve".into(),
                    description: Some("Search the KB".into()),
                    invocation_number: 2,
                    parameters: vec![ToolParameter {
                        name: "query".into(),
                        value: "rust".into(),
                    }],
                },
            ),
            (
                r#"{"type":"tool_complete","toolName":"retrieve","invocationNumber":2,"status":"error"}"#,
                AgentEvent::ToolComplete {
                    tool_name: "retrieve".into(),
                    invocation_number: 2,
                    status: "error".into(),
                },
            ),
            (
                r#"{"type":"final_response","content":"Hello there","sessionId":"s-1",
                    "messageId":"m-1","references":"[]","reasoningContent":"thinking",
                    "structuredOutput":"{\"a\":1}"}"#,
                AgentEvent::FinalResponse(FinalResponse {
                    content: "Hello there".into(),
                    session_id: "s-1".into(),
                    message_id: "m-1".into(),
                    references: Some("[]".into()),
                    reasoning_content: Some("thinking".into()),
                    structured_output: Some("{\"a\":1}".into()),
                }),
            ),
            (
                r#"{"type":"error","message":"model timed out"}"#,
                AgentEvent::ServerError {
                    message: "model timed out".into(),
                },
            ),
            (r#"{"type":"heartbeat_ack"}"#, AgentEvent::HeartbeatAck),
        ];

        for (raw, expected) in cases {
            let decoded = decode(raw).expect("contract frame must decode");
            assert_eq!(decoded, expected, "mismatch for {raw}");
        }
    }

    #[test]
    fn final_response_optional_fields_are_absent_when_omitted() {
        let decoded =
            decode(r#"{"type":"final_response","content":"hi","sessionId":"s","messageId":"m"}"#)
                .expect("decode");
        let AgentEvent::FinalResponse(final_response) = decoded else {
            panic!("wrong variant");
        };
        assert_eq!(final_response.references, None);
        assert_eq!(final_response.reasoning_content, None);
        assert_eq!(final_response.structured_output, None);
    }

    #[test]
    fn tool_complete_defaults_to_success_like_the_browser() {
        let decoded = decode(r#"{"type":"tool_complete","toolName":"calc","invocationNumber":1}"#)
            .expect("decode");
        assert_eq!(
            decoded,
            AgentEvent::ToolComplete {
                tool_name: "calc".into(),
                invocation_number: 1,
                status: "success".into(),
            }
        );
    }

    #[test]
    fn tool_action_pairs_with_tool_complete_when_counters_are_absent() {
        // A container that omits `invocationNumber` omits it on both halves, so
        // the default must be the *same* on both or the indicator never resolves.
        let action = decode(r#"{"type":"tool_action","toolName":"calc"}"#).expect("decode");
        let complete = decode(r#"{"type":"tool_complete","toolName":"calc"}"#).expect("decode");

        let (
            AgentEvent::ToolAction {
                invocation_number: started,
                ..
            },
            AgentEvent::ToolComplete {
                invocation_number: finished,
                ..
            },
        ) = (&action, &complete)
        else {
            panic!("wrong variants: {action:?} / {complete:?}");
        };
        assert_eq!(started, finished);
    }

    #[test]
    fn empty_tool_description_reads_as_absent() {
        let decoded =
            decode(r#"{"type":"tool_action","toolName":"calc","description":""}"#).expect("decode");
        let AgentEvent::ToolAction { description, .. } = decoded else {
            panic!("wrong variant");
        };
        assert_eq!(description, None);
    }

    #[test]
    fn non_string_tool_parameter_values_are_rendered_not_dropped() {
        let decoded = decode(
            r#"{"type":"tool_action","toolName":"calc","parameters":[
                {"name":"nums","value":[1,2]},{"name":"flag","value":true},
                {"value":"nameless"},{"name":"bare"}]}"#,
        )
        .expect("decode");
        let AgentEvent::ToolAction { parameters, .. } = decoded else {
            panic!("wrong variant");
        };
        assert_eq!(
            parameters,
            vec![
                ToolParameter {
                    name: "nums".into(),
                    value: "[1,2]".into()
                },
                ToolParameter {
                    name: "flag".into(),
                    value: "true".into()
                },
                // The nameless entry is skipped; a nothing-but-name entry keeps
                // the name, because that is still information.
                ToolParameter {
                    name: "bare".into(),
                    value: String::new()
                },
            ]
        );
    }

    /// The load-bearing case: swarm / graph / agents-as-tools are separate
    /// containers, and voice frames share the same socket. None of them may
    /// end a chat.
    #[test]
    fn unknown_types_are_tolerated_never_fatal() {
        for r#type in [
            "bidi_audio_stream",
            "bidi_transcript_stream",
            "bidi_text_response",
            "bidi_interruption",
            "bidi_response_complete",
            "tool_use_stream",
            "tool_result",
            "tool_result_message",
            "tool_stream",
            "tool_description",
            "some_future_swarm_event",
        ] {
            let raw = format!(r#"{{"type":"{type}","whatever":123}}"#);
            let decoded = decode(&raw).unwrap_or_else(|err| panic!("{type} must not error: {err}"));
            assert_eq!(
                decoded,
                AgentEvent::Unknown {
                    r#type: r#type.to_string()
                }
            );
        }
    }

    #[test]
    fn malformed_json_is_the_only_transport_level_failure() {
        assert!(matches!(decode("not json"), Err(DecodeError::Json(_))));
        assert!(matches!(decode(""), Err(DecodeError::Json(_))));
    }

    #[test]
    fn a_frame_without_a_usable_type_is_an_error() {
        assert!(matches!(decode("{}"), Err(DecodeError::MissingType)));
        // A non-string `type` cannot be echoed into `Unknown`, so it is an
        // error rather than a silently stringified surprise.
        assert!(matches!(
            decode(r#"{"type":7}"#),
            Err(DecodeError::MissingType)
        ));
    }

    #[test]
    fn a_known_type_missing_its_meaning_bearing_field_names_both() {
        let err = decode(r#"{"type":"text_token","sequenceNumber":1}"#)
            .expect_err("text_token without data must fail");
        let DecodeError::MissingField { r#type, field } = err else {
            panic!("wrong error: {err:?}");
        };
        assert_eq!(r#type, "text_token");
        assert_eq!(field, "data");

        for (raw, expected_field) in [
            (r#"{"type":"tool_action"}"#, "toolName"),
            (r#"{"type":"tool_complete"}"#, "toolName"),
            (r#"{"type":"final_response","sessionId":"s"}"#, "content"),
            (r#"{"type":"error"}"#, "message"),
        ] {
            let err = decode(raw).expect_err("must fail");
            let DecodeError::MissingField { field, .. } = err else {
                panic!("wrong error for {raw}: {err:?}");
            };
            assert_eq!(field, expected_field, "for {raw}");
        }
    }

    #[test]
    fn decorative_fields_fall_back_rather_than_failing() {
        // Exactly the shape a container reusing the contract without the
        // single-agent bookkeeping would send.
        let decoded = decode(r#"{"type":"text_token","data":"tok"}"#).expect("decode");
        assert_eq!(
            decoded,
            AgentEvent::TextToken {
                data: "tok".into(),
                sequence_number: 0,
                run_id: None,
            }
        );
    }
}
