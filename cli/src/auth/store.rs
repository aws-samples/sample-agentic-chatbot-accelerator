//! Persisting a signed-in session between runs, so relaunching does not mean
//! retyping a password.
//!
//! **This file holds secrets**, which is what separates it from
//! [`crate::config`]'s cache (documented as non-secret by construction). It
//! reverses the MVP's "no credential persistence between runs" decision, on
//! request, after a real run showed ~11s of Cognito round trips on *every*
//! launch — paid ten times in one afternoon.
//!
//! Three things bound the risk that reversal creates:
//!
//! 1. **Our own 24h expiry**, independent of Cognito's 30-day refresh-token
//!    validity. A stolen file is worthless a day later even though the token
//!    inside it would still be honoured, and an expired file is *deleted* on the
//!    next run rather than left lying around.
//! 2. **`0600` inside a `0700` directory**, via the same helpers the config cache
//!    uses. That is file permissions, not encryption: anything running as this
//!    user can read it. The OS keychain was the considered alternative and was
//!    declined — it needs a dependency tree `make run-ash` cannot SCA-scan for
//!    Rust, and fails awkwardly on headless Linux.
//! 3. **Keyed by deployment and user.** A file written against another user pool,
//!    another app client, or another email is a miss, never a reuse — silently
//!    presenting one user's session as another's is the one failure mode here
//!    that would be worse than the latency this exists to remove.
//!
//! Every miss is non-fatal by construction: a corrupt, stale, foreign or revoked
//! file degrades to "ask for the password", which is exactly the behaviour that
//! existed before this module.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::telemetry::Secret;

/// Filename inside [`crate::config::config_dir`].
const SESSION_FILE: &str = "session.json";

/// How long a persisted session may be reused, regardless of how long Cognito
/// would still honour the refresh token inside it.
///
/// Cognito's refresh token is valid 30 days here. Trusting that in full would
/// mean a file that unlocks the account for a month; capping it at a day keeps
/// almost every relaunch instant while bounding what a copied file is worth.
pub const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// A session on disk.
///
/// `Secret` is deliberately *not* used for the fields here: `Secret` exists to
/// keep values out of logs and `Debug` output, and these have to serialise. They
/// are converted to `Secret` the moment they are handed out by [`Session::into_tokens`],
/// and this type has no `Debug` at all so it cannot be printed by accident.
#[derive(Serialize, Deserialize)]
struct Stored {
    /// Which user pool this belongs to. A mismatch is a miss.
    user_pool_id: String,
    /// Which app client. Tokens are client-scoped, so this is part of identity.
    user_pool_client_id: String,
    /// Whose session. Shown to the user on reuse, and compared against `--email`.
    email: String,
    /// Renews the ID token without a password. The reason this file is sensitive.
    refresh_token: String,
    /// The current ID token, kept so a relaunch inside the hour needs **no**
    /// Cognito call at all — not even `REFRESH_TOKEN_AUTH`.
    id_token: String,
    /// `id_token`'s expiry, seconds since the epoch.
    id_token_expires_at_secs: u64,
    /// The identity-pool id for this user, so `GetId` can be skipped.
    ///
    /// Safe to cache only because this file is keyed by user: handing one user
    /// another's identity id was the exact reason this was not cached earlier.
    identity_id: Option<String>,
    /// When this file was written, for the [`MAX_AGE`] cap.
    stored_at_secs: u64,
}

/// A reusable session, already checked against the current deployment and user.
pub struct Session {
    pub email: String,
    pub refresh_token: Secret<String>,
    /// `Some` only while still comfortably valid; `None` means "refresh it".
    pub fresh_id_token: Option<Secret<String>>,
    pub id_token_expires_at: SystemTime,
    pub identity_id: Option<String>,
}

impl Session {
    /// The tokens in the shape [`crate::auth::CredentialBroker`] wants.
    pub fn into_tokens(self, id_token: Secret<String>, expires_at: SystemTime) -> super::Tokens {
        super::Tokens {
            id_token,
            // Not persisted: nothing in this CLI uses the access token, so
            // storing a third credential would add risk for no capability.
            access_token: Secret::new(String::new()),
            refresh_token: Some(self.refresh_token),
            expires_at,
        }
    }
}

/// Where the session file lives.
pub fn session_path() -> PathBuf {
    crate::config::config_dir().join(SESSION_FILE)
}

/// Load a reusable session for this deployment and user, if there is one.
///
/// `wanted_email` is `--email` when given: a stored session for a *different*
/// user is a miss, so `--email other@example.com` signs in as that person
/// instead of silently reusing whoever was cached.
///
/// Deletes the file when it is too old, so an expired secret does not linger.
pub fn load(
    config: &crate::config::AppConfig,
    wanted_email: Option<&str>,
    now: SystemTime,
) -> Option<Session> {
    load_at(&session_path(), config, wanted_email, now)
}

/// Testable core of [`load`]. Every failure mode collapses to `None`.
fn load_at(
    path: &Path,
    config: &crate::config::AppConfig,
    wanted_email: Option<&str>,
    now: SystemTime,
) -> Option<Session> {
    let raw = std::fs::read_to_string(path).ok()?;
    let stored: Stored = match serde_json::from_str(&raw) {
        Ok(stored) => stored,
        Err(err) => {
            // Not the token itself, and not the file body: only the fact that it
            // could not be read. A parse error carrying a fragment of the
            // document would put part of a refresh token in the log.
            tracing::warn!("ignoring unreadable session file: {err}");
            return None;
        }
    };

    // Age first: an expired session is deleted rather than merely skipped, so a
    // machine that stops being used does not keep a usable credential forever.
    let stored_at = UNIX_EPOCH + Duration::from_secs(stored.stored_at_secs);
    let age = now.duration_since(stored_at).unwrap_or(Duration::ZERO);
    if age >= MAX_AGE {
        tracing::info!("discarding a saved session older than the 24h cap");
        // Removed at `path`, not at `session_path()`: taking the path as an
        // argument and then deleting a global one would make this function
        // untestable without destroying the developer's own session.
        remove(path);
        return None;
    }

    // A file belonging to another deployment or another user is never reused.
    // Left in place: it is still valid for whoever it belongs to, and deleting
    // it would sign them out because someone else ran one command.
    if stored.user_pool_id != config.user_pool_id
        || stored.user_pool_client_id != config.user_pool_client_id
    {
        tracing::info!("saved session belongs to another deployment; ignoring it");
        return None;
    }
    if let Some(wanted) = wanted_email
        && !wanted.eq_ignore_ascii_case(&stored.email)
    {
        tracing::info!("saved session belongs to another user; ignoring it");
        return None;
    }

    let id_token_expires_at = UNIX_EPOCH + Duration::from_secs(stored.id_token_expires_at_secs);
    // Reusable only with the same margin the in-process broker demands, so a
    // token that would expire mid-handshake is refreshed instead.
    let fresh = id_token_expires_at
        .duration_since(now)
        .is_ok_and(|left| left > super::REFRESH_BUFFER);

    Some(Session {
        email: stored.email,
        refresh_token: Secret::new(stored.refresh_token),
        fresh_id_token: fresh.then(|| Secret::new(stored.id_token)),
        id_token_expires_at,
        identity_id: stored.identity_id,
    })
}

/// Persist a session. Never fatal: failing to save costs one password prompt
/// next time, which is no reason to refuse to chat now.
pub fn save(
    config: &crate::config::AppConfig,
    email: &str,
    tokens: &super::Tokens,
    identity_id: Option<&str>,
    now: SystemTime,
) {
    save_at(&session_path(), config, email, tokens, identity_id, now);
}

/// Testable core of [`save`], so a test never writes to the real session path.
fn save_at(
    path: &Path,
    config: &crate::config::AppConfig,
    email: &str,
    tokens: &super::Tokens,
    identity_id: Option<&str>,
    now: SystemTime,
) {
    // Nothing to save without a refresh token: an ID token alone would expire
    // within the hour and cannot renew itself, so the file would be dead weight
    // holding a live credential.
    let Some(refresh_token) = &tokens.refresh_token else {
        tracing::info!("pool issued no refresh token; not saving a session");
        return;
    };

    let stored = Stored {
        user_pool_id: config.user_pool_id.clone(),
        user_pool_client_id: config.user_pool_client_id.clone(),
        email: email.to_string(),
        refresh_token: refresh_token.expose().clone(),
        id_token: tokens.id_token.expose().clone(),
        id_token_expires_at_secs: unix_secs(tokens.expires_at),
        identity_id: identity_id.map(str::to_string),
        stored_at_secs: unix_secs(now),
    };

    if let Err(err) = write(path, &stored) {
        tracing::warn!("could not save the session: {err}");
    }
}

/// Serialise and write `0600` inside a `0700` directory.
fn write(path: &Path, stored: &Stored) -> std::io::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        crate::config::create_private_dir(parent)?;
    }
    // Compact, not pretty: unlike the config cache this is not a file anyone is
    // invited to read, and pretty-printing it would only make the token easier
    // to lift out by eye.
    let body = serde_json::to_vec(stored).map_err(std::io::Error::other)?;
    crate::config::write_private_file(path, &body)
}

/// Delete the saved session. Idempotent — a missing file is success.
pub fn forget() {
    remove(&session_path());
}

/// Delete `path`, treating "already gone" as success.
fn remove(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => tracing::info!("removed the saved session"),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => tracing::warn!("could not remove the saved session: {err}"),
    }
}

/// Seconds since the epoch, clamped at 0 for a pre-1970 clock.
fn unix_secs(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> crate::config::AppConfig {
        crate::config::AppConfig {
            region: "us-east-1".into(),
            account_id: "123456789012".into(),
            user_pool_id: "us-east-1_Pool".into(),
            user_pool_client_id: "client".into(),
            identity_pool_id: "us-east-1:identity".into(),
            appsync_url: Some("https://example.invalid/graphql".into()),
        }
    }

    fn stored(now: SystemTime, id_token_valid_for: Duration) -> Stored {
        Stored {
            user_pool_id: "us-east-1_Pool".into(),
            user_pool_client_id: "client".into(),
            email: "alice@example.com".into(),
            refresh_token: "refresh-token-value".into(),
            id_token: "id-token-value".into(),
            id_token_expires_at_secs: unix_secs(now + id_token_valid_for),
            identity_id: Some("us-east-1:abc".into()),
            stored_at_secs: unix_secs(now),
        }
    }

    fn temp_path() -> PathBuf {
        std::env::temp_dir().join(format!("aca-session-test-{}.json", uuid::Uuid::new_v4()))
    }

    #[test]
    fn a_fresh_session_round_trips_and_needs_no_cognito_call() {
        let now = SystemTime::now();
        let path = temp_path();
        write(&path, &stored(now, Duration::from_secs(3600))).expect("write");

        let session = load_at(&path, &config(), None, now).expect("a reusable session");
        assert_eq!(session.email, "alice@example.com");
        assert_eq!(session.refresh_token.expose(), "refresh-token-value");
        // The whole point: an ID token with an hour left is used as-is, so a
        // relaunch inside the hour makes no auth request at all.
        assert_eq!(
            session.fresh_id_token.map(|token| token.expose().clone()),
            Some("id-token-value".to_string())
        );
        assert_eq!(session.identity_id.as_deref(), Some("us-east-1:abc"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_id_token_inside_the_refresh_buffer_is_not_reused() {
        // Reusing it would hand a token to the presigner that expires during the
        // handshake — the same margin the in-process broker refreshes on.
        let now = SystemTime::now();
        let path = temp_path();
        write(&path, &stored(now, super::super::REFRESH_BUFFER / 2)).expect("write");

        let session = load_at(&path, &config(), None, now).expect("still reusable");
        assert!(
            session.fresh_id_token.is_none(),
            "a nearly-expired ID token must be refreshed, not reused"
        );
        // The refresh token is what makes that recoverable without a password.
        assert_eq!(session.refresh_token.expose(), "refresh-token-value");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_session_past_the_age_cap_is_refused() {
        let now = SystemTime::now();
        let path = temp_path();
        // Written a day and a minute ago, with an ID token that is somehow still
        // valid: the cap must win regardless of what the tokens claim.
        let mut old = stored(now, Duration::from_secs(3600));
        old.stored_at_secs = unix_secs(now - MAX_AGE - Duration::from_secs(60));
        write(&path, &old).expect("write");

        assert!(load_at(&path, &config(), None, now).is_none());
        // Deleted, not merely skipped: an expired credential must not linger on
        // a machine that has stopped being used.
        assert!(!path.exists(), "an expired session file must be removed");
    }

    #[test]
    fn a_session_from_another_deployment_or_user_is_never_reused() {
        let now = SystemTime::now();

        // Another user pool.
        let path = temp_path();
        let mut other = stored(now, Duration::from_secs(3600));
        other.user_pool_id = "us-east-1_Different".into();
        write(&path, &other).expect("write");
        assert!(load_at(&path, &config(), None, now).is_none());
        let _ = std::fs::remove_file(&path);

        // Another app client: tokens are client-scoped.
        let path = temp_path();
        let mut other = stored(now, Duration::from_secs(3600));
        other.user_pool_client_id = "another-client".into();
        write(&path, &other).expect("write");
        assert!(load_at(&path, &config(), None, now).is_none());
        let _ = std::fs::remove_file(&path);

        // Another user, named explicitly with --email.
        let path = temp_path();
        write(&path, &stored(now, Duration::from_secs(3600))).expect("write");
        assert!(
            load_at(&path, &config(), Some("bob@example.com"), now).is_none(),
            "--email naming someone else must not reuse alice's session"
        );
        // The same user in a different case is still the same user.
        assert!(load_at(&path, &config(), Some("ALICE@Example.com"), now).is_some());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_missing_or_corrupt_file_is_a_miss_not_an_error() {
        let now = SystemTime::now();
        assert!(load_at(&temp_path(), &config(), None, now).is_none());

        let path = temp_path();
        std::fs::write(&path, b"{not json at all").expect("write");
        assert!(load_at(&path, &config(), None, now).is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_written_unreadable_to_anyone_else() {
        use std::os::unix::fs::PermissionsExt;

        let now = SystemTime::now();
        let path = temp_path();
        // Pre-create it world-readable: `mode` on open only applies at creation,
        // so a file left behind by an earlier version must still be tightened.
        std::fs::write(&path, b"{}").expect("write");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");

        write(&path, &stored(now, Duration::from_secs(3600))).expect("write");

        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "session file is {:o}", mode & 0o777);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_pool_without_refresh_tokens_saves_nothing() {
        // An ID token alone cannot renew itself, so the file would be a live
        // credential that buys nothing.
        let now = SystemTime::now();
        let path = temp_path();
        let tokens = super::super::Tokens {
            id_token: Secret::new("id".into()),
            access_token: Secret::new("access".into()),
            refresh_token: None,
            expires_at: now + Duration::from_secs(3600),
        };

        save_at(&path, &config(), "alice@example.com", &tokens, None, now);
        assert!(
            !path.exists(),
            "nothing may be written without a refresh token"
        );
    }

    #[test]
    fn saving_then_loading_preserves_what_a_relaunch_needs() {
        let now = SystemTime::now();
        let path = temp_path();
        let tokens = super::super::Tokens {
            id_token: Secret::new("id-token-value".into()),
            access_token: Secret::new("access-token-value".into()),
            refresh_token: Some(Secret::new("refresh-token-value".into())),
            expires_at: now + Duration::from_secs(3600),
        };

        save_at(
            &path,
            &config(),
            "Alice@Example.com",
            &tokens,
            Some("us-east-1:abc"),
            now,
        );
        let session = load_at(&path, &config(), None, now).expect("a reusable session");

        assert_eq!(session.email, "Alice@Example.com");
        assert_eq!(session.refresh_token.expose(), "refresh-token-value");
        assert_eq!(session.identity_id.as_deref(), Some("us-east-1:abc"));

        // The access token is deliberately not persisted, so it cannot come back.
        let body = std::fs::read_to_string(&path).expect("read");
        assert!(
            !body.contains("access-token-value"),
            "the access token must not be written to disk"
        );

        let _ = std::fs::remove_file(&path);
    }
}
