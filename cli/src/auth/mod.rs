//! Cognito authentication, split across two independent ~1h lifetimes.
//!
//! `login` (T7) obtains the ID token; `credentials` (T8) exchanges it for
//! temporary AWS credentials. They are separate modules because the two artefacts
//! expire independently and refresh through different calls
//! (`REFRESH_TOKEN_AUTH` vs. re-running `GetCredentialsForIdentity`). Conflating
//! them is precisely how a session that outlives an hour becomes silently
//! unreconnectable: re-presigning needs credentials, and getting credentials
//! needs a live ID token.
//!
//! `store` is the third piece and the only one that writes to disk: it persists
//! enough of a signed-in session to skip the password prompt on the next run.
//! Read its module docs before changing it — it is the one place in this crate
//! that keeps a credential after the process exits.

pub mod credentials;
pub mod login;
pub mod store;

pub use credentials::{CredentialBroker, CredentialError, REFRESH_BUFFER};
pub use login::{
    Identity, LoginError, NewPasswordPrompt, Tokens, identity_from_id_token, login,
    refresh_id_token, sdk_config_without_credentials,
};

use crate::telemetry::Secret;

/// Temporary AWS credentials from the Cognito Identity Pool (~1h).
///
/// Defined here rather than in `credentials.rs` (T8) because the *pure* lane
/// needs it first: `presign::PresignInput` borrows one, and T6 lands before T8.
/// The type is a plain data carrier with no IO, so it belongs to neither task
/// exclusively.
///
/// Deliberately **no** derived `Debug` — see the manual impl below.
#[derive(Clone)]
pub struct AwsCreds {
    pub access_key_id: String,
    pub secret_access_key: Secret<String>,
    pub session_token: Secret<String>,
    /// `Option` because the API models it that way. Treat `None` as "refresh on
    /// next use", never as "never expires".
    pub expires_at: Option<std::time::SystemTime>,
}

/// Hand-written so the access key id — which is not secret, and is the only
/// field worth seeing in a log — is readable while the other two stay wrapped.
/// A derived `Debug` would be safe today only because `Secret` redacts; writing
/// it out makes that independent of `Secret`'s implementation.
impl std::fmt::Debug for AwsCreds {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AwsCreds")
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &"[redacted]")
            .field("session_token", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_reveals_no_secret() {
        let creds = AwsCreds {
            access_key_id: "NOTAREALKEYIDFORTESTS".to_string(),
            secret_access_key: Secret::new("shhh-secret-key".to_string()),
            session_token: Secret::new("shhh-session-token".to_string()),
            expires_at: None,
        };

        let rendered = format!("{creds:?}");
        assert!(rendered.contains("NOTAREALKEYIDFORTESTS"));
        assert!(!rendered.contains("shhh"));
    }
}
