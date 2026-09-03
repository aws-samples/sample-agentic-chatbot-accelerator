//! Golden-fixture test for the SigV4 WebSocket presign builder.
//!
//! `tests/fixtures/presigned-url.txt` was produced by an *independent*
//! implementation — `@smithy/signature-v4` 4.2.4, the exact library the React
//! app signs with (see `src/user-interface/react-app/src/websocket-presigned.ts`)
//! — driven by a throwaway Node script with the fixed inputs recorded below.
//! This test asserts [`presign_ws_url`] reproduces that URL byte-for-byte. It is
//! the only correctness signal available offline, because a wrong signature is
//! rejected by AgentCore as a bare 403, indistinguishable from every other
//! handshake failure (design-doc risk 2).
//!
//! ## Exact inputs that produced the fixture — the fixture is meaningless without them
//!
//! | input | value |
//! |---|---|
//! | access key id | `NOTAREALKEYIDFORTESTS` (prefix-free so the secret scanner does not block the commit) |
//! | secret access key | `wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY` |
//! | session token | `FQoGZXIvYXdzEXAMPLESESSIONTOKENVALUEplusslash+and/chars==` |
//! | region | `us-west-2` |
//! | account id | `123456789012` |
//! | agent runtime id | `my_agent-AbCdEf` |
//! | qualifier | `DEFAULT` |
//! | session id | `6ba7b810-9dad-11d1-80b4-00c04fd430c8-cli` (40 chars, >= 33) |
//! | `X-Amz-Date` | `20260902T101112Z` (i.e. `2026-09-02T10:11:12Z`) |
//! | `X-Amz-Expires` | `300` |
//!
//! The fixture was generated with `X-Amz-Expires=300`, which is
//! [`EXPIRES_IN_SECS`] — the documented maximum this CLI enforces, deliberately
//! *not* the browser's 3600. The two facts are kept separate on purpose: the
//! browser relies on undocumented leniency, and [`presign_ws_url`] rejects
//! anything above 300 (see `rejects_expiry_above_the_documented_maximum`). The
//! signing algorithm is identical regardless of the expiry value, so generating
//! at 300 exercises the same code path while keeping the golden test aligned
//! with the enforced maximum.

use std::time::{Duration, SystemTime};

use aca_cli::auth::AwsCreds;
use aca_cli::presign::{EXPIRES_IN_SECS, PresignError, PresignInput, presign_ws_url, runtime_arn};
use aca_cli::protocol::SessionId;
use aca_cli::telemetry::Secret;

const ACCESS_KEY_ID: &str = "NOTAREALKEYIDFORTESTS";
const SECRET_ACCESS_KEY: &str = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY";
const SESSION_TOKEN: &str = "FQoGZXIvYXdzEXAMPLESESSIONTOKENVALUEplusslash+and/chars==";
const REGION: &str = "us-west-2";
const ACCOUNT_ID: &str = "123456789012";
const AGENT_RUNTIME_ID: &str = "my_agent-AbCdEf";
const QUALIFIER: &str = "DEFAULT";
const SESSION_ID: &str = "6ba7b810-9dad-11d1-80b4-00c04fd430c8-cli";
/// `20260902T101112Z` as seconds since the Unix epoch.
const SIGNING_EPOCH_SECS: u64 = 1_788_343_872;

fn fixture_creds() -> AwsCreds {
    AwsCreds {
        access_key_id: ACCESS_KEY_ID.to_string(),
        secret_access_key: Secret::new(SECRET_ACCESS_KEY.to_string()),
        session_token: Secret::new(SESSION_TOKEN.to_string()),
        // `None`, not the real expiry: the presign signature does not cover the
        // credentials' own expiry, so it does not affect the fixture.
        expires_at: None,
    }
}

#[test]
fn reproduces_the_browser_generated_url_byte_for_byte() {
    // The repo's `end-of-file-fixer` pre-commit hook mandates a trailing newline
    // on every text file, so the fixture carries one and the test strips it. Only
    // the trailing newline: `trim_end` rather than `trim` so a stray leading or
    // internal space would still fail rather than being silently tolerated.
    let expected = include_str!("fixtures/presigned-url.txt").trim_end_matches('\n');
    assert!(
        !expected.contains(char::is_whitespace),
        "fixture URL must contain no whitespace"
    );

    let session_id = SessionId::parse(SESSION_ID).expect("fixture session id is valid");
    let creds = fixture_creds();
    let at = SystemTime::UNIX_EPOCH + Duration::from_secs(SIGNING_EPOCH_SECS);

    let url = presign_ws_url(PresignInput {
        region: REGION,
        account_id: ACCOUNT_ID,
        agent_runtime_id: AGENT_RUNTIME_ID,
        qualifier: QUALIFIER,
        session_id: &session_id,
        credentials: &creds,
        at,
        expires_in: Duration::from_secs(EXPIRES_IN_SECS),
    })
    .expect("presign must succeed");

    assert_eq!(
        url, expected,
        "presigned URL diverged from the @smithy/signature-v4 fixture"
    );
}

#[test]
fn runtime_arn_matches_the_browser_format() {
    // The literal string the browser builds in `connectToAgent`.
    assert_eq!(
        runtime_arn(REGION, ACCOUNT_ID, AGENT_RUNTIME_ID),
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-AbCdEf"
    );
}

#[test]
fn rejects_expiry_above_the_documented_maximum() {
    let session_id = SessionId::parse(SESSION_ID).expect("valid session id");
    let creds = fixture_creds();
    let at = SystemTime::UNIX_EPOCH + Duration::from_secs(SIGNING_EPOCH_SECS);

    // One second over the documented maximum — the browser's 3600 would also
    // land here, which is the point: we do not follow it.
    let over = Duration::from_secs(EXPIRES_IN_SECS + 1);
    let err = presign_ws_url(PresignInput {
        region: REGION,
        account_id: ACCOUNT_ID,
        agent_runtime_id: AGENT_RUNTIME_ID,
        qualifier: QUALIFIER,
        session_id: &session_id,
        credentials: &creds,
        at,
        expires_in: over,
    })
    .expect_err("an over-long expiry must be rejected");

    let PresignError::ExpiryTooLong { got } = err else {
        panic!("wrong error variant: {err:?}");
    };
    assert_eq!(got, over);
}

#[test]
fn expiry_exactly_at_the_maximum_is_accepted() {
    // The boundary is inclusive: 300s is the documented maximum, not one below.
    let session_id = SessionId::parse(SESSION_ID).expect("valid session id");
    let creds = fixture_creds();
    let at = SystemTime::UNIX_EPOCH + Duration::from_secs(SIGNING_EPOCH_SECS);

    let result = presign_ws_url(PresignInput {
        region: REGION,
        account_id: ACCOUNT_ID,
        agent_runtime_id: AGENT_RUNTIME_ID,
        qualifier: QUALIFIER,
        session_id: &session_id,
        credentials: &creds,
        at,
        expires_in: Duration::from_secs(EXPIRES_IN_SECS),
    });
    assert!(result.is_ok(), "300s must be accepted: {result:?}");
}
