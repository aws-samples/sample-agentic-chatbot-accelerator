//! Cognito `USER_PASSWORD_AUTH` login and the first-login password challenge.
//!
//! This module obtains the ID token half of the two independent ~1h lifetimes
//! (`credentials` owns the other). It authenticates with email + password, walks
//! exactly one `NEW_PASSWORD_REQUIRED` challenge to completion, and fails loudly —
//! by name — on anything else, so a user never sees a bare 4xx or a stack trace.

use std::collections::HashMap;
use std::time::{Duration, SystemTime};

use aws_config::{BehaviorVersion, Region};
use aws_sdk_cognitoidentityprovider::error::ProvideErrorMetadata;
use aws_sdk_cognitoidentityprovider::types::{
    AuthFlowType, AuthenticationResultType, ChallengeNameType,
};

use crate::telemetry::Secret;

/// Build an AWS SDK config that makes **no** attempt to resolve credentials.
///
/// `InitiateAuth`, `RespondToAuthChallenge`, `GetId` and
/// `GetCredentialsForIdentity` are all IAM-unauthenticated, but the SDK's default
/// credential chain still runs and fails on a machine with no AWS config — which
/// is exactly this CLI's primary scenario (a user who has only a CloudFront URL
/// and a Cognito account). `ConfigLoader::no_credentials()` short-circuits that
/// chain so the process never touches `~/.aws` or the instance-metadata endpoint.
///
/// The method is on `ConfigLoader`, not on a per-service `config::Builder`, so it
/// is set here once and both Cognito clients (T7 and T8) are built from the
/// resulting [`aws_config::SdkConfig`].
pub async fn sdk_config_without_credentials(region: &str) -> aws_config::SdkConfig {
    aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(region.to_string()))
        .no_credentials()
        .load()
        .await
}

/// A successful authentication.
pub struct Tokens {
    /// The identity JWT presented to our own backend and to the identity pool.
    pub id_token: Secret<String>,
    /// The access JWT (Cognito scopes); unused by the chat path but returned for
    /// completeness and future control-plane calls.
    pub access_token: Secret<String>,
    /// Present unless the pool is configured without refresh. Long-lived
    /// (commonly 30 days) — held in memory only, never persisted.
    pub refresh_token: Option<Secret<String>>,
    /// When the ID/access tokens expire (~1h out). Drives T8's refresh decision.
    pub expires_at: SystemTime,
}

/// Who we are, as the agent container must be told.
#[derive(Debug, Clone)]
pub struct Identity {
    /// Cognito `sub`. Guaranteed non-empty by construction.
    pub sub: String,
    /// The user's email, when the ID token carries it. Informational only.
    pub email: Option<String>,
}

/// Authenticate with `USER_PASSWORD_AUTH`.
///
/// Single `InitiateAuth` call; no `SECRET_HASH`, because the app client is
/// created with `generateSecret: false`. On a `NEW_PASSWORD_REQUIRED` challenge
/// this calls `new_password_prompt` to obtain a replacement and completes the
/// challenge before returning.
///
/// `ADMIN_USER_PASSWORD_AUTH` is deliberately **not** used even though the app
/// client enables it: it is only valid on `AdminInitiateAuth`, which needs AWS
/// developer credentials this CLI does not have.
///
/// Errors:
/// - [`LoginError::BadCredentials`] on `NotAuthorizedException`
/// - [`LoginError::UnsupportedChallenge`] naming any other challenge
/// - [`LoginError::ChallengeExpired`] when the ~3-minute challenge session lapses
/// - [`LoginError::MissingSub`] when the ID token carries no usable `sub`
pub async fn login(
    config: &crate::config::AppConfig,
    email: &str,
    password: Secret<String>,
    new_password_prompt: &dyn NewPasswordPrompt,
) -> Result<(Tokens, Identity), LoginError> {
    let sdk_config = sdk_config_without_credentials(&config.region).await;
    let client = aws_sdk_cognitoidentityprovider::Client::new(&sdk_config);

    // A wrong email/password surfaces here as NotAuthorizedException; every other
    // failure is an SDK/transport problem the user cannot act on beyond retrying.
    //
    // Timed because this one call has been observed at ~7.8s against a pool with
    // no Lambda triggers and no advanced-security add-on, while a *rejected*
    // auth on the same pool answers in 170-580ms. Whether that is Cognito
    // verifying a password or the network being slow at the time cannot be told
    // apart without timing each call separately, so each one is timed.
    let started = std::time::Instant::now();
    let initiated = client
        .initiate_auth()
        .client_id(config.user_pool_client_id.as_str())
        .auth_flow(AuthFlowType::UserPasswordAuth)
        .auth_parameters("USERNAME", email)
        .auth_parameters("PASSWORD", password.expose().as_str())
        .send()
        .await
        .map_err(|err| {
            let service = err.into_service_error();
            if service.is_not_authorized_exception() {
                LoginError::BadCredentials
            } else {
                LoginError::Sdk(service.to_string())
            }
        })?;
    tracing::info!(
        call = "InitiateAuth",
        elapsed_ms = started.elapsed().as_millis(),
        "cognito call"
    );

    // A confirmed user with a permanent password authenticates in one round-trip.
    if let Some(result) = initiated.authentication_result() {
        return finish(result);
    }

    match initiated.challenge_name() {
        // `selfSignUpEnabled: false` means every user is admin-created and starts
        // in FORCE_CHANGE_PASSWORD, so this fires on essentially every first login.
        Some(ChallengeNameType::NewPasswordRequired) => {
            let session = initiated
                .session()
                .ok_or_else(|| LoginError::Sdk("challenge returned without a session".into()))?;
            let required = required_attributes(initiated.challenge_parameters());
            let (new_password, attributes) = new_password_prompt.request(&required)?;

            let mut respond = client
                .respond_to_auth_challenge()
                .client_id(config.user_pool_client_id.as_str())
                .challenge_name(ChallengeNameType::NewPasswordRequired)
                .session(session)
                .challenge_responses("USERNAME", email)
                .challenge_responses("NEW_PASSWORD", new_password.expose().as_str());
            // The pool marks given_name/family_name required, so a first login
            // must supply them here or Cognito rejects the response. Keys are
            // `userAttributes.<name>` in challenge responses (see `required_attributes`).
            for (name, value) in attributes {
                respond = respond.challenge_responses(format!("userAttributes.{name}"), value);
            }

            let responded = respond.send().await.map_err(|err| {
                let service = err.into_service_error();
                if service.is_not_authorized_exception() {
                    // The ~3-minute challenge session lapsing also surfaces as
                    // NotAuthorizedException; separating it keeps a distracted
                    // user from reading "expired" as "wrong password".
                    if challenge_session_expired(service.message()) {
                        LoginError::ChallengeExpired
                    } else {
                        LoginError::BadCredentials
                    }
                } else {
                    LoginError::Sdk(service.to_string())
                }
            })?;

            let result = responded.authentication_result().ok_or_else(|| {
                // Answering one challenge only to be handed another (e.g. MFA) is
                // unsupported by this CLI; name whatever came back.
                match responded.challenge_name() {
                    Some(next) => LoginError::UnsupportedChallenge(next.to_string()),
                    None => LoginError::Sdk("challenge answered but no tokens returned".into()),
                }
            })?;
            finish(result)
        }
        // SMS_MFA, SOFTWARE_TOKEN_MFA, MFA_SETUP, … all land here by name.
        Some(other) => Err(LoginError::UnsupportedChallenge(other.to_string())),
        None => Err(LoginError::Sdk(
            "no authentication result and no challenge returned".into(),
        )),
    }
}

/// Mint a fresh ID token from a saved refresh token, with no password.
///
/// Separate from [`crate::auth::CredentialBroker`]'s refresh, which does the same
/// call: that one renews a token the broker already owns mid-run, this one
/// bootstraps a run that has nothing but a file on disk. Sharing the code would
/// mean building a broker before knowing whether the refresh token still works.
///
/// A revoked or expired refresh token surfaces as [`LoginError::BadCredentials`],
/// which the caller is expected to treat as "fall back to asking for a password"
/// rather than as a failure — Cognito answers a dead refresh token and a wrong
/// password with the same `NotAuthorizedException`.
pub async fn refresh_id_token(
    config: &crate::config::AppConfig,
    refresh_token: &str,
) -> Result<(Secret<String>, SystemTime), LoginError> {
    let sdk_config = sdk_config_without_credentials(&config.region).await;
    let client = aws_sdk_cognitoidentityprovider::Client::new(&sdk_config);

    let started = std::time::Instant::now();
    let output = client
        .initiate_auth()
        .client_id(config.user_pool_client_id.as_str())
        .auth_flow(AuthFlowType::RefreshTokenAuth)
        .auth_parameters("REFRESH_TOKEN", refresh_token)
        .send()
        .await
        .map_err(|err| {
            let service = err.into_service_error();
            if service.is_not_authorized_exception() {
                LoginError::BadCredentials
            } else {
                LoginError::Sdk(service.to_string())
            }
        })?;
    tracing::info!(
        call = "InitiateAuth(REFRESH_TOKEN_AUTH)",
        elapsed_ms = started.elapsed().as_millis(),
        "cognito call"
    );

    let result = output
        .authentication_result()
        .ok_or_else(|| LoginError::Sdk("refresh returned no tokens".into()))?;
    let id_token = result
        .id_token()
        .ok_or_else(|| LoginError::Sdk("refresh returned no ID token".into()))?;
    let expires_at = SystemTime::now() + Duration::from_secs(result.expires_in().max(0) as u64);
    Ok((Secret::new(id_token.to_string()), expires_at))
}

/// Supplies a replacement password (and any required attributes) when Cognito
/// demands one. Abstracted so T10/T11 can prompt differently and tests can stub.
pub trait NewPasswordPrompt {
    /// `required_attributes` comes from the challenge parameters — the pool marks
    /// `given_name`/`family_name` as required, so they may be demanded here.
    fn request(
        &self,
        required_attributes: &[String],
    ) -> Result<(Secret<String>, HashMap<String, String>), LoginError>;
}

/// Extract `sub` (and `email` if present) from an ID token's payload.
///
/// Signature verification is deliberately skipped: the token came straight from
/// Cognito over TLS and is only used to identify ourselves to our own backend, so
/// pulling in a JWT-verification crate (and the JWKS fetch it implies) would add
/// dependency surface for no security gain. The base64url payload is decoded by
/// hand rather than adding a `base64` crate for one call site.
///
/// Errors when `sub` is missing or empty — an empty `userId` makes the container's
/// DynamoDB write fail on an empty key attribute, which it downgrades to a
/// warning, so history would be lost with no client-visible error. A token this
/// function cannot decode has no usable `sub` either, so it fails the same way
/// rather than silently continuing with an empty identity.
pub fn identity_from_id_token(id_token: &str) -> Result<Identity, LoginError> {
    // JWT is header.payload.signature; the claims live in the middle segment.
    let payload_b64 = id_token.split('.').nth(1).ok_or(LoginError::MissingSub)?;
    let payload = base64url_decode(payload_b64).ok_or(LoginError::MissingSub)?;
    let claims: serde_json::Value =
        serde_json::from_slice(&payload).map_err(|_| LoginError::MissingSub)?;

    let sub = claims
        .get("sub")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if sub.is_empty() {
        return Err(LoginError::MissingSub);
    }

    let email = claims
        .get("email")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);

    Ok(Identity { sub, email })
}

#[derive(Debug, thiserror::Error)]
pub enum LoginError {
    #[error("incorrect email or password")]
    BadCredentials,
    #[error("this CLI cannot answer the `{0}` challenge; sign in via the web UI once to clear it")]
    UnsupportedChallenge(String),
    #[error(
        "the password-change challenge expired (Cognito allows ~3 minutes); rerun and answer promptly"
    )]
    ChallengeExpired,
    #[error(
        "the ID token contains no usable `sub`; refusing to continue because history would be silently discarded"
    )]
    MissingSub,
    #[error("Cognito call failed: {0}")]
    Sdk(String),
}

/// Turn a completed [`AuthenticationResultType`] into tokens plus identity.
///
/// The `sub` is extracted (and validated non-empty) before the tokens are
/// wrapped, so a token with no usable identity fails before any secret is even
/// constructed.
fn finish(result: &AuthenticationResultType) -> Result<(Tokens, Identity), LoginError> {
    let id_token = result
        .id_token()
        .ok_or_else(|| LoginError::Sdk("authentication result carried no ID token".into()))?;
    let identity = identity_from_id_token(id_token)?;

    let access_token = result
        .access_token()
        .ok_or_else(|| LoginError::Sdk("authentication result carried no access token".into()))?;

    // `expires_in` is seconds-from-now; clamp a nonsensical negative to 0 rather
    // than underflowing the duration.
    let expires_at = SystemTime::now() + Duration::from_secs(result.expires_in().max(0) as u64);

    let tokens = Tokens {
        id_token: Secret::new(id_token.to_string()),
        access_token: Secret::new(access_token.to_string()),
        refresh_token: result
            .refresh_token()
            .map(|token| Secret::new(token.to_string())),
        expires_at,
    };
    Ok((tokens, identity))
}

/// Parse the challenge's `requiredAttributes` into clean attribute names.
///
/// Cognito encodes it as a JSON string array of `userAttribute.<name>` entries;
/// the `userAttribute.` prefix is stripped so the prompt sees `given_name`, and
/// it is re-added (as the plural `userAttributes.`) when the response is built.
fn required_attributes(params: Option<&HashMap<String, String>>) -> Vec<String> {
    params
        .and_then(|params| params.get("requiredAttributes"))
        .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|attr| {
            attr.strip_prefix("userAttribute.")
                .unwrap_or(&attr)
                .to_string()
        })
        .collect()
}

/// True when a `NotAuthorizedException` message indicates the challenge session,
/// not the password, is the problem.
///
/// Cognito reports an expired challenge session as `NotAuthorizedException` with a
/// message like "Invalid session for the user, session is expired"; matching the
/// message is the only signal that distinguishes it from a genuinely wrong
/// password.
fn challenge_session_expired(message: Option<&str>) -> bool {
    message.is_some_and(|message| {
        let message = message.to_ascii_lowercase();
        message.contains("session is expired") || message.contains("session expired")
    })
}

/// Decode a base64url segment (no padding), returning `None` on any stray byte.
///
/// JWTs use the URL-safe alphabet (`-`/`_`) and omit `=` padding, so this both
/// tolerates absent padding and ignores trailing `=` if a producer adds it.
/// Leftover bits in a final partial group are discarded, matching how a canonical
/// base64 decoder treats a truncated tail.
fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }

    let trimmed = input.trim_end_matches('=');
    let mut out = Vec::with_capacity(trimmed.len() * 3 / 4);
    let mut accumulator: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in trimmed.as_bytes() {
        accumulator = (accumulator << 6) | u32::from(sextet(byte)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode bytes as unpadded base64url, so tests can build a JWT payload
    /// without a `base64` dependency. The inverse of [`base64url_decode`].
    fn base64url_encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        let mut accumulator: u32 = 0;
        let mut bits: u32 = 0;
        for &byte in bytes {
            accumulator = (accumulator << 8) | u32::from(byte);
            bits += 8;
            while bits >= 6 {
                bits -= 6;
                out.push(ALPHABET[((accumulator >> bits) & 0x3f) as usize] as char);
            }
        }
        if bits > 0 {
            out.push(ALPHABET[((accumulator << (6 - bits)) & 0x3f) as usize] as char);
        }
        out
    }

    /// Build a JWT-shaped string (`header.payload.signature`) whose payload is the
    /// given JSON. Header and signature are arbitrary — nothing verifies them.
    fn jwt_with_payload(payload: &serde_json::Value) -> String {
        let header = base64url_encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let body = base64url_encode(payload.to_string().as_bytes());
        format!("{header}.{body}.not-a-real-signature")
    }

    #[test]
    fn identity_extracts_sub_and_email() {
        let token = jwt_with_payload(&serde_json::json!({
            "sub": "11111111-2222-3333-4444-555555555555",
            "email": "operator@example.com",
        }));
        let identity = identity_from_id_token(&token).expect("must parse");
        assert_eq!(identity.sub, "11111111-2222-3333-4444-555555555555");
        assert_eq!(identity.email.as_deref(), Some("operator@example.com"));
    }

    #[test]
    fn identity_without_email_is_still_valid() {
        let token = jwt_with_payload(&serde_json::json!({ "sub": "abc-123" }));
        let identity = identity_from_id_token(&token).expect("must parse");
        assert_eq!(identity.sub, "abc-123");
        assert_eq!(identity.email, None);
    }

    /// The DoD's sharpest case: an empty `sub` must be fatal, because an empty
    /// `userId` makes the container silently discard history.
    #[test]
    fn empty_sub_is_rejected() {
        let token = jwt_with_payload(&serde_json::json!({ "sub": "" }));
        assert!(matches!(
            identity_from_id_token(&token),
            Err(LoginError::MissingSub)
        ));
    }

    #[test]
    fn whitespace_only_sub_is_rejected() {
        let token = jwt_with_payload(&serde_json::json!({ "sub": "   " }));
        assert!(matches!(
            identity_from_id_token(&token),
            Err(LoginError::MissingSub)
        ));
    }

    #[test]
    fn absent_sub_is_rejected() {
        let token = jwt_with_payload(&serde_json::json!({ "email": "x@example.com" }));
        assert!(matches!(
            identity_from_id_token(&token),
            Err(LoginError::MissingSub)
        ));
    }

    #[test]
    fn malformed_tokens_are_rejected_not_panicked() {
        for garbage in [
            "",
            "onlyonesegment",
            "two.segments",
            "a.!!!not-base64!!!.c",
            "a..c",
        ] {
            assert!(
                matches!(identity_from_id_token(garbage), Err(LoginError::MissingSub)),
                "expected MissingSub for {garbage:?}"
            );
        }
    }

    /// The decoder must handle every payload length modulo 4, since JWTs omit
    /// padding: a payload whose base64 has 2 or 3 trailing chars is common.
    #[test]
    fn base64url_round_trips_all_tail_lengths() {
        for len in 0..8usize {
            let original: Vec<u8> = (0..len).map(|i| (i as u8).wrapping_mul(37)).collect();
            let encoded = base64url_encode(&original);
            assert!(!encoded.contains('='), "encoder must not pad: {encoded:?}");
            let decoded = base64url_decode(&encoded).expect("decode");
            assert_eq!(decoded, original, "round-trip failed for len {len}");
        }
    }

    /// Trailing `=` padding, if a producer adds it, must be tolerated.
    #[test]
    fn base64url_tolerates_padding() {
        let decoded = base64url_decode("YWJj").expect("no pad");
        assert_eq!(decoded, b"abc");
        let padded = base64url_decode("YWI=").expect("padded");
        assert_eq!(padded, b"ab");
    }

    #[test]
    fn required_attributes_strips_the_prefix() {
        let mut params = HashMap::new();
        params.insert(
            "requiredAttributes".to_string(),
            r#"["userAttribute.given_name","userAttribute.family_name"]"#.to_string(),
        );
        let attrs = required_attributes(Some(&params));
        assert_eq!(attrs, vec!["given_name", "family_name"]);
    }

    #[test]
    fn required_attributes_absent_is_empty() {
        assert!(required_attributes(None).is_empty());
        assert!(required_attributes(Some(&HashMap::new())).is_empty());
    }

    #[test]
    fn challenge_session_expiry_is_distinguished_from_bad_password() {
        assert!(challenge_session_expired(Some(
            "Invalid session for the user, session is expired."
        )));
        assert!(!challenge_session_expired(Some(
            "Incorrect username or password."
        )));
        assert!(!challenge_session_expired(None));
    }
}
