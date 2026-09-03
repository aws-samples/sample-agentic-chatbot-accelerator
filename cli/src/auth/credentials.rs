//! Identity-pool credential exchange and dual-lifetime refresh.
//!
//! The Cognito ID token (from `login`, T7) and the temporary AWS credentials it
//! is exchanged for both live ~1h, but they expire independently and refresh
//! through different calls:
//!
//! - STS credentials → re-run `GetCredentialsForIdentity`
//! - ID token → `InitiateAuth` with `REFRESH_TOKEN_AUTH`
//!
//! Conflating them is how a session that outlives an hour becomes silently
//! unreconnectable: re-presigning needs credentials, and getting credentials
//! needs a live ID token. Keeping the two lifetimes distinct — each with its own
//! expiry check and refresh path — is the whole reason this is a separate module.
//!
//! Nothing *here* touches the filesystem: every secret this module holds lives in
//! memory only, wrapped in [`Secret`]. Persistence across runs is
//! [`crate::auth::store`]'s job and its risks are documented there — this module
//! only ever receives tokens and hands back credentials.

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, SystemTime};

use aws_sdk_cognitoidentityprovider::types::AuthFlowType;

use super::AwsCreds;
use crate::telemetry::Secret;

/// Refresh this far ahead of expiry, matching the browser's behaviour
/// (`src/user-interface/react-app/src/aws-credentials.ts`).
pub const REFRESH_BUFFER: Duration = Duration::from_secs(5 * 60);

/// Owns both expiring artefacts and hands out valid credentials on demand.
///
/// The two ~1h lifetimes are tracked separately (`id_token_expires_at` vs. the
/// credentials' own `expires_at`) and refreshed by different calls, so an expired
/// credential set is renewed without disturbing a still-valid ID token and vice
/// versa. All state is in memory; nothing is persisted.
pub struct CredentialBroker {
    /// The AWS-facing calls, behind a trait so tests can inject a fake and assert
    /// the refresh *decisions* without a network or real credentials.
    backend: Box<dyn Backend>,
    /// Injected so refresh timing is unit-testable; production is `SystemTime::now`.
    clock: Box<dyn Fn() -> SystemTime + Send + Sync>,
    /// The current ID token, refreshed via `REFRESH_TOKEN_AUTH`.
    id_token: Secret<String>,
    /// When [`Self::id_token`] expires. Distinct from the credentials' expiry.
    id_token_expires_at: SystemTime,
    /// Long-lived refresh token, if the pool issues one. Absent means the ID
    /// token cannot be renewed — a later expiry is then [`CredentialError::RefreshUnavailable`].
    refresh_token: Option<Secret<String>>,
    /// Cached STS credentials. `None` until first fetched, and treated as
    /// "refresh on next use" thereafter if their own `expires_at` is `None`.
    creds: Option<AwsCreds>,
    /// The identity-pool id in use, so it can be persisted and skip `GetId` on
    /// the next launch. Not a secret: it identifies an identity, it does not
    /// authenticate as one.
    identity_id: String,
}

impl CredentialBroker {
    /// Perform the initial `GetId` → `GetCredentialsForIdentity` exchange.
    ///
    /// `Logins` key format is `cognito-idp.<region>.amazonaws.com/<userPoolId>` —
    /// mirrors `src/user-interface/react-app/src/aws-credentials.ts`. Uses the
    /// **enhanced** flow (`GetId` then `GetCredentialsForIdentity`) because the
    /// pool has no `allowClassicFlow`. Both SDK clients are built from T7's
    /// [`sdk_config_without_credentials`](super::sdk_config_without_credentials),
    /// since these calls are IAM-unauthenticated.
    pub async fn new(
        config: &crate::config::AppConfig,
        tokens: crate::auth::Tokens,
        cached_identity_id: Option<String>,
    ) -> Result<Self, CredentialError> {
        let sdk_config = super::sdk_config_without_credentials(&config.region).await;
        let identity_client = aws_sdk_cognitoidentity::Client::new(&sdk_config);
        let idp_client = aws_sdk_cognitoidentityprovider::Client::new(&sdk_config);

        let logins_key = logins_key(&config.region, &config.user_pool_id);

        // A cached identity id skips `GetId` entirely — one of the two serial
        // round trips here, since the second call needs the first's answer.
        // Only safe because the session store is keyed by user: handing one
        // user another's identity id is exactly why this was not cached before.
        let reused_identity_id = cached_identity_id.is_some();
        let identity_id = match cached_identity_id {
            Some(identity_id) => identity_id,
            None => {
                get_id(
                    &identity_client,
                    config,
                    &logins_key,
                    tokens.id_token.expose(),
                )
                .await?
            }
        };

        // The initial credential fetch is part of "the initial exchange", so a
        // freshly-built broker already holds a usable credential set.
        let id_token = tokens.id_token.expose().clone();
        let (identity_id, creds) =
            match get_credentials(&identity_client, &identity_id, &logins_key, &id_token).await {
                Ok(creds) => (identity_id, creds),
                // A cached identity id the pool no longer recognises (identity
                // deleted, pool recreated) must not brick the CLI: fall back to the
                // `GetId` that caching it skipped. Only retried when the id *was*
                // reused — a freshly-fetched one failing is a real error.
                Err(err) if reused_identity_id => {
                    tracing::warn!("cached identity id rejected ({err}); re-running GetId");
                    let fresh = get_id(&identity_client, config, &logins_key, &id_token).await?;
                    let creds =
                        get_credentials(&identity_client, &fresh, &logins_key, &id_token).await?;
                    (fresh, creds)
                }
                Err(err) => return Err(err),
            };

        let backend = AwsBackend {
            identity_client,
            idp_client,
            identity_id: identity_id.clone(),
            user_pool_client_id: config.user_pool_client_id.clone(),
            logins_key,
        };

        Ok(Self {
            backend: Box::new(backend),
            clock: Box::new(SystemTime::now),
            id_token: tokens.id_token,
            id_token_expires_at: tokens.expires_at,
            refresh_token: tokens.refresh_token,
            creds: Some(creds),
            identity_id,
        })
    }

    /// The identity-pool id this broker is using, for the session store.
    pub fn identity_id(&self) -> &str {
        &self.identity_id
    }

    /// Return credentials valid for at least [`REFRESH_BUFFER`], refreshing
    /// whatever has expired first. Cheap when nothing needs refreshing.
    ///
    /// The ID token is refreshed *before* the credentials, because
    /// `GetCredentialsForIdentity` needs a live ID token: renewing credentials
    /// with a stale token would fail, which is the exact silent-unreconnect trap
    /// this module exists to avoid.
    pub async fn current(&mut self) -> Result<AwsCreds, CredentialError> {
        self.ensure_id_token_fresh().await?;

        if self.creds_need_refresh() {
            let id_token = self.id_token.expose().clone();
            self.creds = Some(self.backend.fetch_credentials(&id_token).await?);
        }

        self.creds.clone().ok_or(CredentialError::Incomplete)
    }

    /// The raw ID token, for AppSync's `Authorization` header (T12).
    /// Refreshes first if needed.
    pub async fn id_token(&mut self) -> Result<Secret<String>, CredentialError> {
        self.ensure_id_token_fresh().await?;
        Ok(self.id_token.clone())
    }

    /// Renew the ID token if it is within [`REFRESH_BUFFER`] of expiry.
    ///
    /// A refresh is impossible without a refresh token, so an expired ID token
    /// with none is [`CredentialError::RefreshUnavailable`] — reported before any
    /// network call, so the user is told to sign in again rather than seeing a
    /// downstream credential failure.
    async fn ensure_id_token_fresh(&mut self) -> Result<(), CredentialError> {
        if !needs_refresh(
            Some(self.id_token_expires_at),
            (self.clock)(),
            REFRESH_BUFFER,
        ) {
            return Ok(());
        }

        let refresh_token = self
            .refresh_token
            .as_ref()
            .ok_or(CredentialError::RefreshUnavailable)?
            .expose()
            .clone();

        let refreshed = self.backend.refresh_id_token(&refresh_token).await?;
        self.id_token = refreshed.id_token;
        self.id_token_expires_at = refreshed.expires_at;
        Ok(())
    }

    /// Whether the cached credentials are missing or within the refresh buffer.
    fn creds_need_refresh(&self) -> bool {
        match &self.creds {
            None => true,
            Some(creds) => needs_refresh(creds.expires_at, (self.clock)(), REFRESH_BUFFER),
        }
    }
}

/// A fresh ID token plus its new expiry, from `REFRESH_TOKEN_AUTH`.
///
/// No new refresh token: `REFRESH_TOKEN_AUTH` does not rotate it, so the broker
/// keeps the one it already holds.
struct RefreshedToken {
    id_token: Secret<String>,
    expires_at: SystemTime,
}

/// The AWS calls the broker makes, abstracted so `current()`'s refresh logic can
/// be exercised with an injected clock and a fake, no-network backend.
trait Backend: Send + Sync {
    /// Re-run `GetCredentialsForIdentity` with a live ID token for fresh STS creds.
    fn fetch_credentials<'a>(
        &'a self,
        id_token: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<AwsCreds, CredentialError>> + Send + 'a>>;

    /// `InitiateAuth` with `REFRESH_TOKEN_AUTH` for a fresh ID token.
    fn refresh_id_token<'a>(
        &'a self,
        refresh_token: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<RefreshedToken, CredentialError>> + Send + 'a>>;
}

/// Production backend: the two Cognito SDK clients plus the ids they need.
struct AwsBackend {
    identity_client: aws_sdk_cognitoidentity::Client,
    idp_client: aws_sdk_cognitoidentityprovider::Client,
    identity_id: String,
    user_pool_client_id: String,
    logins_key: String,
}

/// `GetId`: the identity-pool id for this user. One round trip.
///
/// A free function rather than a method so [`CredentialBroker::new`] can call it
/// *after* a cached id has been rejected, without the backend having to expose a
/// way to mutate the id it was built with.
async fn get_id(
    client: &aws_sdk_cognitoidentity::Client,
    config: &crate::config::AppConfig,
    logins_key: &str,
    id_token: &str,
) -> Result<String, CredentialError> {
    let started = std::time::Instant::now();
    let identity = client
        .get_id()
        .identity_pool_id(config.identity_pool_id.as_str())
        .logins(logins_key.to_string(), id_token)
        .send()
        .await
        .map_err(|err| CredentialError::IdentityPool(err.into_service_error().to_string()))?;
    tracing::info!(
        call = "GetId",
        elapsed_ms = started.elapsed().as_millis(),
        "cognito call"
    );
    Ok(identity
        .identity_id()
        .ok_or(CredentialError::Incomplete)?
        .to_string())
}

/// `GetCredentialsForIdentity`: temporary AWS credentials. One round trip.
///
/// Shared by the initial exchange and every later refresh, so the "a partial
/// credential set is unusable" rule cannot drift between the two paths.
async fn get_credentials(
    client: &aws_sdk_cognitoidentity::Client,
    identity_id: &str,
    logins_key: &str,
    id_token: &str,
) -> Result<AwsCreds, CredentialError> {
    let started = std::time::Instant::now();
    let output = client
        .get_credentials_for_identity()
        .identity_id(identity_id)
        .logins(logins_key.to_string(), id_token)
        .send()
        .await
        .map_err(|err| CredentialError::IdentityPool(err.into_service_error().to_string()))?;
    tracing::info!(
        call = "GetCredentialsForIdentity",
        elapsed_ms = started.elapsed().as_millis(),
        "cognito call"
    );

    let creds = output.credentials().ok_or(CredentialError::Incomplete)?;
    // Every field is required to sign a request; a partial set is unusable,
    // and the identity-pool role grants only InvokeAgentRuntime[...] on
    // runtime/*, so these creds are never used for a control-plane call.
    let access_key_id = creds.access_key_id().ok_or(CredentialError::Incomplete)?;
    let secret_key = creds.secret_key().ok_or(CredentialError::Incomplete)?;
    let session_token = creds.session_token().ok_or(CredentialError::Incomplete)?;

    Ok(AwsCreds {
        access_key_id: access_key_id.to_string(),
        secret_access_key: Secret::new(secret_key.to_string()),
        session_token: Secret::new(session_token.to_string()),
        expires_at: creds
            .expiration()
            .and_then(|dt| SystemTime::try_from(*dt).ok()),
    })
}

impl Backend for AwsBackend {
    fn fetch_credentials<'a>(
        &'a self,
        id_token: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<AwsCreds, CredentialError>> + Send + 'a>> {
        Box::pin(get_credentials(
            &self.identity_client,
            &self.identity_id,
            &self.logins_key,
            id_token,
        ))
    }

    fn refresh_id_token<'a>(
        &'a self,
        refresh_token: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<RefreshedToken, CredentialError>> + Send + 'a>> {
        Box::pin(async move {
            let output = self
                .idp_client
                .initiate_auth()
                .client_id(self.user_pool_client_id.as_str())
                .auth_flow(AuthFlowType::RefreshTokenAuth)
                .auth_parameters("REFRESH_TOKEN", refresh_token)
                .send()
                .await
                .map_err(|err| {
                    CredentialError::IdentityPool(err.into_service_error().to_string())
                })?;

            let result = output
                .authentication_result()
                .ok_or(CredentialError::Incomplete)?;
            let id_token = result.id_token().ok_or(CredentialError::Incomplete)?;
            let expires_at =
                SystemTime::now() + Duration::from_secs(result.expires_in().max(0) as u64);

            Ok(RefreshedToken {
                id_token: Secret::new(id_token.to_string()),
                expires_at,
            })
        })
    }
}

/// The identity-pool `Logins` provider key, e.g.
/// `cognito-idp.us-west-2.amazonaws.com/us-west-2_ExamplePool`.
fn logins_key(region: &str, user_pool_id: &str) -> String {
    format!("cognito-idp.{region}.amazonaws.com/{user_pool_id}")
}

/// Whether an artefact expiring at `expires_at` should be refreshed now.
///
/// `None` means "refresh on next use", never "never expires": the API models
/// expiry as optional, and treating an unknown expiry as infinite is how a
/// credential set that has actually lapsed keeps being handed out.
fn needs_refresh(expires_at: Option<SystemTime>, now: SystemTime, buffer: Duration) -> bool {
    match expires_at {
        None => true,
        Some(expires_at) => now + buffer >= expires_at,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("identity pool refused the token: {0}")]
    IdentityPool(String),
    #[error("the ID token expired and no refresh token is available; sign in again")]
    RefreshUnavailable,
    #[error("the identity pool returned an incomplete credential set")]
    Incomplete,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A no-network backend that hands out canned artefacts and counts calls, so
    /// a test can assert exactly when `current()` decides to refresh.
    #[derive(Default)]
    struct FakeBackend {
        creds_calls: AtomicUsize,
        id_token_calls: AtomicUsize,
        /// Expiry stamped on every credential set the fake returns.
        creds_expiry: Option<SystemTime>,
    }

    impl Backend for FakeBackend {
        fn fetch_credentials<'a>(
            &'a self,
            _id_token: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<AwsCreds, CredentialError>> + Send + 'a>> {
            self.creds_calls.fetch_add(1, Ordering::SeqCst);
            let expires_at = self.creds_expiry;
            Box::pin(async move {
                Ok(AwsCreds {
                    access_key_id: "NOTAREALKEYIDFORTESTS".to_string(),
                    secret_access_key: Secret::new("test-secret-key".to_string()),
                    session_token: Secret::new("test-session-token".to_string()),
                    expires_at,
                })
            })
        }

        fn refresh_id_token<'a>(
            &'a self,
            _refresh_token: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<RefreshedToken, CredentialError>> + Send + 'a>>
        {
            self.id_token_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                Ok(RefreshedToken {
                    id_token: Secret::new("refreshed-id-token".to_string()),
                    expires_at: SystemTime::now() + Duration::from_secs(3600),
                })
            })
        }
    }

    /// Build a broker directly, bypassing `new`'s network exchange.
    fn broker_with(
        backend: Box<dyn Backend>,
        clock: Box<dyn Fn() -> SystemTime + Send + Sync>,
        id_token_expires_at: SystemTime,
        refresh_token: Option<Secret<String>>,
        creds: Option<AwsCreds>,
    ) -> CredentialBroker {
        CredentialBroker {
            backend,
            clock,
            id_token: Secret::new("initial-id-token".to_string()),
            id_token_expires_at,
            refresh_token,
            creds,
            identity_id: "us-east-1:test-identity".to_string(),
        }
    }

    #[test]
    fn needs_refresh_treats_none_as_refresh_now() {
        let now = SystemTime::now();
        assert!(needs_refresh(None, now, REFRESH_BUFFER));
    }

    #[test]
    fn needs_refresh_respects_the_buffer() {
        let now = SystemTime::now();
        // Expires well outside the buffer: no refresh.
        assert!(!needs_refresh(
            Some(now + Duration::from_secs(3600)),
            now,
            REFRESH_BUFFER
        ));
        // Expires inside the buffer: refresh.
        assert!(needs_refresh(
            Some(now + Duration::from_secs(60)),
            now,
            REFRESH_BUFFER
        ));
    }

    /// The acceptance check: `current()` refreshes credentials once they fall
    /// inside `REFRESH_BUFFER`, and leaves them alone while they are outside it.
    #[tokio::test]
    async fn current_refreshes_only_inside_the_buffer() {
        let base = SystemTime::now();
        let clock_state = std::sync::Arc::new(Mutex::new(base));
        let clock_handle = clock_state.clone();
        let clock = Box::new(move || *clock_handle.lock().unwrap());

        let backend = std::sync::Arc::new(FakeBackend {
            creds_expiry: Some(base + Duration::from_secs(600)),
            ..Default::default()
        });

        // A thin adapter so the test can still read the shared FakeBackend's
        // counters after handing a boxed clone to the broker.
        struct Shared(std::sync::Arc<FakeBackend>);
        impl Backend for Shared {
            fn fetch_credentials<'a>(
                &'a self,
                id_token: &'a str,
            ) -> Pin<Box<dyn Future<Output = Result<AwsCreds, CredentialError>> + Send + 'a>>
            {
                self.0.fetch_credentials(id_token)
            }
            fn refresh_id_token<'a>(
                &'a self,
                refresh_token: &'a str,
            ) -> Pin<Box<dyn Future<Output = Result<RefreshedToken, CredentialError>> + Send + 'a>>
            {
                self.0.refresh_id_token(refresh_token)
            }
        }

        let mut broker = broker_with(
            Box::new(Shared(backend.clone())),
            clock,
            base + Duration::from_secs(3600), // ID token stays fresh throughout.
            Some(Secret::new("refresh-token".to_string())),
            Some(AwsCreds {
                access_key_id: "NOTAREALKEYIDFORTESTS".to_string(),
                secret_access_key: Secret::new("k".to_string()),
                session_token: Secret::new("t".to_string()),
                expires_at: Some(base + Duration::from_secs(600)),
            }),
        );

        // Outside the buffer (600s to go, buffer 300s): no fetch.
        broker.current().await.expect("current");
        assert_eq!(backend.creds_calls.load(Ordering::SeqCst), 0);

        // Advance so only 200s remain (< 300s buffer): one fetch.
        *clock_state.lock().unwrap() = base + Duration::from_secs(400);
        broker.current().await.expect("current");
        assert_eq!(backend.creds_calls.load(Ordering::SeqCst), 1);
        // The ID token never entered its buffer, so it was never refreshed.
        assert_eq!(backend.id_token_calls.load(Ordering::SeqCst), 0);
    }

    /// An expired ID token with no refresh token is a fatal, network-free error.
    #[tokio::test]
    async fn expired_id_token_without_refresh_is_unavailable() {
        let now = SystemTime::now();
        let backend = FakeBackend::default();
        let mut broker = broker_with(
            Box::new(backend),
            Box::new(move || now),
            now, // already inside the buffer.
            None,
            None,
        );

        assert!(matches!(
            broker.current().await,
            Err(CredentialError::RefreshUnavailable)
        ));
    }

    /// The credentials this module hands out must not print their secret fields.
    #[test]
    fn handed_out_creds_redact_secrets_in_debug() {
        let creds = AwsCreds {
            access_key_id: "NOTAREALKEYIDFORTESTS".to_string(),
            secret_access_key: Secret::new("super-secret-key".to_string()),
            session_token: Secret::new("super-secret-token".to_string()),
            expires_at: None,
        };
        let rendered = format!("{creds:?}");
        assert!(rendered.contains("NOTAREALKEYIDFORTESTS"));
        assert!(!rendered.contains("super-secret"));
    }

    #[test]
    fn logins_key_matches_the_browser_format() {
        assert_eq!(
            logins_key("us-west-2", "us-west-2_ExamplePool"),
            "cognito-idp.us-west-2.amazonaws.com/us-west-2_ExamplePool"
        );
    }
}
