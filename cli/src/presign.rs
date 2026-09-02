//! SigV4 query-string presign for the AgentCore WebSocket handshake.
//!
//! Pure and deterministic given a clock and credentials, because **a wrong
//! signature is indistinguishable from every other 403** (design-doc risk 2):
//! the runtime rejects a bad presign with a bare handshake failure that looks
//! exactly like an expired token, a wrong region, or a missing endpoint. The
//! golden-fixture test in `cli/tests/` is therefore the only practical proof
//! this module is correct before a live connection — it pins the output of this
//! function against a URL produced independently by `@smithy/signature-v4`, the
//! exact signer the React app uses.
//!
//! The reference client is `src/user-interface/react-app/src/websocket-presigned.ts`.
//! This module reproduces its request shape exactly: same path, same
//! pre-signing query params, same empty-body hash, same single signed header.

use std::borrow::Cow;
use std::time::Duration;

use aws_sigv4::http_request::{
    SignableBody, SignableRequest, SignatureLocation, SigningSettings, sign,
};
use aws_sigv4::sign::v4;

/// Documented maximum presign lifetime for AgentCore WebSocket URLs.
///
/// The React app signs with 3600, 12x this — undocumented leniency we do not
/// rely on. Do not "align" this with the browser: a URL that outlives the
/// documented window is a bearer credential valid longer than AWS guarantees,
/// and [`presign_ws_url`] rejects any `expires_in` above it.
pub const EXPIRES_IN_SECS: u64 = 300;

/// AgentCore's SigV4 service name. Signing under any other name yields a
/// signature the runtime will not accept.
const SERVICE_NAME: &str = "bedrock-agentcore";

/// Everything needed to produce a signed URL. Deterministic: same input,
/// same output.
#[derive(Debug, Clone)]
pub struct PresignInput<'a> {
    pub region: &'a str,
    pub account_id: &'a str,
    pub agent_runtime_id: &'a str,
    /// Endpoint name, e.g. `DEFAULT`.
    pub qualifier: &'a str,
    pub session_id: &'a crate::protocol::SessionId,
    pub credentials: &'a crate::auth::AwsCreds,
    /// Injected so tests can pin a fixed clock.
    pub at: std::time::SystemTime,
    pub expires_in: std::time::Duration,
}

/// Produce the signed `wss://` URL.
///
/// Contract, all of which the golden fixture pins:
/// - service name `bedrock-agentcore`, `SignatureLocation::QueryParams`
/// - path `/runtimes/<uri-encoded runtime ARN>/ws`
/// - query `qualifier` + `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` present
///   **before** signing, so they are covered by the signature
/// - signed payload is the empty-string SHA256, **not** an unsigned-payload
///   marker — the browser's signer hashes an absent body this way
/// - `host` is the only signed header
/// - the session token participates in the canonical request
///   (`SessionTokenMode::Include`, which is the crate default)
///
/// The returned string is a **bearer credential**: never log it, never accept
/// it as an argument. Use `telemetry::redact_presigned_url` for diagnostics.
pub fn presign_ws_url(input: PresignInput<'_>) -> Result<String, PresignError> {
    // Enforced before signing so an over-long URL is never even produced: the
    // presigned URL is a bearer credential, and one valid past the documented
    // window is a longer-lived credential than AWS guarantees to honour.
    if input.expires_in.as_secs() > EXPIRES_IN_SECS {
        return Err(PresignError::ExpiryTooLong {
            got: input.expires_in,
        });
    }

    let arn = runtime_arn(input.region, input.account_id, input.agent_runtime_id);
    let host = format!("bedrock-agentcore.{}.amazonaws.com", input.region);

    // The ARN is a single opaque path segment. It is URI-encoded exactly once
    // here (mirroring the browser's `encodeURIComponent`); the signer's
    // `PercentEncodingMode::Double` re-encodes the `%` in the *canonical*
    // request, which is what makes our signature match the browser's without us
    // double-encoding the transmitted path.
    let encoded_arn = encode_uri_component(&arn);

    // Pre-signing query params. They MUST be in the URI handed to the signer so
    // the signature covers them — a URL where `qualifier` or the session id
    // could be swapped after signing would authenticate a different request.
    let qualifier_enc = encode_uri_component(input.qualifier);
    let session_id_enc = encode_uri_component(input.session_id.as_str());
    let sign_uri = format!(
        "https://{host}/runtimes/{encoded_arn}/ws\
         ?qualifier={qualifier_enc}\
         &X-Amzn-Bedrock-AgentCore-Runtime-Session-Id={session_id_enc}"
    );

    // `Credentials::new` takes owned `String`s; expose the wrapped secrets only
    // here, at the one call site that has to.
    let creds = aws_credential_types::Credentials::new(
        input.credentials.access_key_id.clone(),
        input.credentials.secret_access_key.expose().clone(),
        Some(input.credentials.session_token.expose().clone()),
        input.credentials.expires_at,
        "aca-cli",
    );
    let identity = creds.into();

    let mut settings = SigningSettings::default();
    settings.signature_location = SignatureLocation::QueryParams;
    settings.expires_in = Some(input.expires_in);
    // Everything else stays default on purpose: `PercentEncodingMode::Double`,
    // `UriPathNormalizationMode::Enabled` and `SessionTokenMode::Include` are
    // exactly what make this canonicalise the same way `@smithy/signature-v4`
    // does. Changing any of them silently breaks the signature.

    let signing_params = v4::SigningParams::builder()
        .identity(&identity)
        .region(input.region)
        .name(SERVICE_NAME)
        .time(input.at)
        .settings(settings)
        .build()
        .map_err(|err| PresignError::Signing(err.to_string()))?
        .into();

    // Empty-string SHA256, not `UnsignedPayload`: the browser hashes an absent
    // body to the empty-string digest, and the two markers produce different
    // canonical requests and therefore different signatures.
    let signable = SignableRequest::new(
        "GET",
        &sign_uri,
        std::iter::empty(),
        SignableBody::Bytes(&[]),
    )
    .map_err(|err| PresignError::Signing(err.to_string()))?;

    let (instructions, _signature) = sign(signable, &signing_params)
        .map_err(|err| PresignError::Signing(err.to_string()))?
        .into_parts();

    // The signer returns the `X-Amz-*` params it computed, but not in the order
    // the browser emits them, and without the pre-signing params. We assemble
    // the final query in the browser's exact insertion order (below), so the
    // output matches its URL byte-for-byte; a mismatch here is a real defect,
    // not a cosmetic one, because the fixture is the only correctness signal.
    let (_headers, signed_params) = instructions.into_parts();
    let mut signed: Vec<(&str, Cow<'_, str>)> = signed_params;

    let take = |signed: &mut Vec<(&str, Cow<'_, str>)>, name: &str| -> Option<String> {
        signed
            .iter()
            .position(|(key, _)| *key == name)
            .map(|idx| signed.remove(idx).1.into_owned())
    };

    // Browser order, from `websocket-presigned.ts` -> `SignatureV4.presign`:
    // the pre-signing params first, then the security token, then the standard
    // SigV4 params in the order the JS signer inserts them. Do NOT sort this or
    // re-encode after the fact — `connect_async` takes the string verbatim, and
    // the byte order is part of what the fixture pins.
    let mut pairs: Vec<(String, String)> = vec![
        ("qualifier".to_string(), input.qualifier.to_string()),
        (
            "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id".to_string(),
            input.session_id.as_str().to_string(),
        ),
    ];
    // The session token is always present for Cognito identity-pool creds, but
    // guard anyway: if the signer omitted it we must not emit an empty param.
    if let Some(token) = take(&mut signed, "X-Amz-Security-Token") {
        pairs.push(("X-Amz-Security-Token".to_string(), token));
    }
    for name in [
        "X-Amz-Algorithm",
        "X-Amz-Credential",
        "X-Amz-Date",
        "X-Amz-Expires",
        "X-Amz-SignedHeaders",
        "X-Amz-Signature",
    ] {
        let value = take(&mut signed, name).ok_or_else(|| {
            PresignError::Signing(format!("signer did not return required param {name}"))
        })?;
        pairs.push((name.to_string(), value));
    }

    let query = pairs
        .iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                encode_uri_component(key),
                encode_uri_component(value)
            )
        })
        .collect::<Vec<_>>()
        .join("&");

    Ok(format!("wss://{host}/runtimes/{encoded_arn}/ws?{query}"))
}

/// Build `arn:aws:bedrock-agentcore:{region}:{account_id}:runtime/{runtime_id}`.
///
/// Mirrors the browser exactly — `RuntimeSummary` from AppSync does not return
/// this ARN (only the A2A twin), so the client must assemble it.
pub fn runtime_arn(region: &str, account_id: &str, agent_runtime_id: &str) -> String {
    format!("arn:aws:bedrock-agentcore:{region}:{account_id}:runtime/{agent_runtime_id}")
}

/// Percent-encode a string the way JavaScript's `encodeURIComponent` does.
///
/// The browser assembles its final URL with `encodeURIComponent` on every key
/// and value, so byte-for-byte reproduction requires the identical unreserved
/// set: `A-Z a-z 0-9 - _ . ! ~ * ' ( )` pass through, everything else becomes
/// uppercase `%XX`. This is deliberately *not* the signer's canonical encoding
/// (`fmt_string`); it is only used to lay out the transmitted URL.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(nibble_to_hex(byte >> 4));
            out.push(nibble_to_hex(byte & 0x0f));
        }
    }
    out
}

/// Map a 4-bit nibble to its uppercase hex digit.
fn nibble_to_hex(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'A' + (nibble - 10)) as char,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PresignError {
    #[error("signing failed: {0}")]
    Signing(String),
    #[error("expiry {got:?} exceeds the documented maximum of {EXPIRES_IN_SECS}s")]
    ExpiryTooLong { got: Duration },
}
