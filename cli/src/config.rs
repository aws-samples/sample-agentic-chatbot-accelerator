//! Backend identity resolution, using **no AWS credentials**.
//!
//! This is the module that makes the CLI usable by someone who has only a
//! CloudFront URL and a Cognito user. Three layers are merged, highest
//! precedence first:
//!
//! 1. **Flags / `ACA_*` env** — an explicit override always wins, so a split or
//!    hand-rolled stack can be addressed field by field.
//! 2. **The on-disk cache** — non-secret ids only, so the second run of the day
//!    needs no flags and no network.
//! 3. **The deployment's public `aws-exports.json`** — fetched over plain HTTPS
//!    with no `Authorization` header and no signature, because it is served
//!    publicly by CloudFront. That credential-free property is the whole reason
//!    this file is the config contract rather than CloudFormation outputs, whose
//!    keys are hash-suffixed and whose stack name depends on the
//!    non-git-versioned `config.yaml` (design doc decision 5 / ADR-0008).
//!
//! The fetch here is also the first real TLS connection the process makes, which
//! is why T1's throwaway `tls::smoke_check` was folded into it rather than kept:
//! a crypto-provider clash surfaces as a runtime panic, and this call site is now
//! the one that would trip it.
//!
//! Nothing in this module reads or writes a secret. [`AppConfig`] has no secret
//! field, so [`save_cache`] is *structurally* incapable of persisting a token —
//! that is a type-level guarantee rather than a filter applied at write time.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Cache file name inside the config directory.
///
/// JSON, not the `config.toml` the task plan named: the crate has no `toml`
/// dependency and adding one to store five strings is not worth the supply-chain
/// surface. `serde_json` is already in the graph for `aws-exports.json` itself.
const CACHE_FILE: &str = "config.json";

/// Directory name shared by the cache and (under a different base) the log.
const APP_DIR: &str = "aca-cli";

/// Ceiling on the exports GET.
///
/// A CloudFront edge either answers in milliseconds or is unreachable; without a
/// timeout a black-holed connection would hang the CLI before it has printed
/// anything a user could interpret.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Everything the CLI needs to reach a deployment.
///
/// Every field except [`AppConfig::appsync_url`] is required. Deliberately holds
/// **no** secret: this type is what gets serialised to the cache, so keeping it
/// credential-free by construction is what makes the cache safe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppConfig {
    /// AWS region hosting the deployment.
    pub region: String,
    /// AWS account id, needed for the runtime ARN a presign signs over.
    pub account_id: String,
    /// Cognito user pool id, also half of the identity-pool `Logins` key.
    pub user_pool_id: String,
    /// Cognito user pool *app client* id used for `USER_PASSWORD_AUTH`.
    pub user_pool_client_id: String,
    /// Cognito identity pool id exchanged for SigV4 credentials.
    pub identity_pool_id: String,
    /// AppSync GraphQL endpoint. Only needed for discovery (T12); absent is
    /// tolerable when `--runtime-id` is supplied, so a deployment whose AppSync
    /// endpoint is unreachable can still be chatted with.
    pub appsync_url: Option<String>,
}

/// The subset of `aws-exports.json` this CLI reads.
///
/// Field names match the deployed file exactly — verified against
/// `iac-cdk/lib/user-interface/index.ts`, the `UserInterface` construct that
/// generates it. Unlisted keys (`Auth`, `aws_appsync_region`,
/// `aws_bedrock_supported_models`, …) are ignored by serde, so a deployment that
/// gains a key does not break the parse.
///
/// `non_snake_case` is allowed at struct scope rather than on the one offending
/// field: a field-level `allow` does not suppress this lint (rustc checks field
/// names against the enclosing item), so the struct is the narrowest scope that
/// actually works.
#[derive(Debug, Clone, Deserialize)]
#[allow(non_snake_case)]
pub struct AwsExports {
    /// → [`AppConfig::region`].
    pub aws_project_region: String,
    /// → [`AppConfig::account_id`].
    pub aws_account_id: String,
    /// → [`AppConfig::user_pool_id`].
    pub aws_user_pools_id: String,
    /// → [`AppConfig::user_pool_client_id`].
    pub aws_user_pools_web_client_id: String,
    /// → [`AppConfig::identity_pool_id`].
    pub aws_cognito_identity_pool_id: String,

    /// → [`AppConfig::appsync_url`].
    ///
    /// The mixed case is the literal key in the deployed file, so the field name
    /// mirrors it rather than being "fixed". The `rename` is redundant today *on
    /// purpose*: it pins the wire name, so a future tidy-up of the Rust
    /// identifier cannot silently stop matching the deployment.
    #[serde(rename = "aws_appsync_graphqlEndpoint")]
    pub aws_appsync_graphqlEndpoint: Option<String>,
}

/// Resolve config with precedence: explicit flags/env > cache > fetched exports.
///
/// Performs an unauthenticated HTTPS GET when `--aws-exports-url` is set and the
/// needed fields aren't already supplied — so a warm cache means no network call
/// at all. Writes the resolved **non-secret** fields back to the cache unless
/// `--no-cache`.
///
/// Errors when the merged result is still missing a required field, naming every
/// missing field and the flag that would supply it. A cache write failure is
/// **not** an error: being unable to memoise five ids is no reason to refuse to
/// chat, so it is logged and ignored.
pub async fn resolve(args: &crate::args::ConfigArgs) -> Result<AppConfig, ConfigError> {
    let mut partial = Partial::from_args(args);

    // The cache is consulted before the network, per the specified precedence.
    // Known consequence: pointing `--aws-exports-url` at a *different*
    // deployment while a complete cache exists resolves the cached one, because
    // no field is left for the fetch to supply. `--no-cache` is the escape
    // hatch; the cache is not keyed by source URL because `save_cache` takes an
    // `AppConfig`, which has nowhere to record one.
    let cached = if args.no_cache { None } else { load_cache() };
    if let Some(cached) = cached.clone() {
        partial.fill_from(Partial::from(cached));
    }

    if !partial.is_satisfied()
        && let Some(url) = clean(args.aws_exports_url.clone())
    {
        partial.fill_from(Partial::from(fetch_exports(&url).await?));
    }

    let config = partial.into_complete()?;

    // Skip a no-op write so a steady-state run touches the filesystem zero times.
    if !args.no_cache
        && cached.as_ref() != Some(&config)
        && let Err(err) = save_cache(&config)
    {
        tracing::warn!("config cache not updated: {err}");
    }

    Ok(config)
}

/// Fetch and parse the deployment's public exports file. No credentials.
///
/// Deliberately sends no `Authorization` header and signs nothing: the file is
/// public. If a deployment ever puts the distribution behind auth, this contract
/// breaks — that is the constraint ADR-0008 records.
///
/// The body is read as text and handed to `serde_json` rather than using
/// `Response::json`, so a deployment serving an HTML error page yields
/// [`ConfigError::Parse`] ("not a valid aws-exports.json") instead of a generic
/// transport error.
pub async fn fetch_exports(url: &str) -> Result<AwsExports, ConfigError> {
    let fetch_error = |source| ConfigError::Fetch {
        url: url.to_string(),
        source,
    };

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(fetch_error)?;

    let body = client
        .get(url)
        .send()
        .await
        .map_err(fetch_error)?
        .error_for_status()
        .map_err(fetch_error)?
        .text()
        .await
        .map_err(fetch_error)?;

    // Routed through the redactor even though a public exports URL carries no
    // signature: every URL in this crate reaches the log the same way, so no
    // future call site has to remember which ones are credentials.
    tracing::debug!(
        url = %crate::telemetry::redact_presigned_url(url),
        bytes = body.len(),
        "fetched aws-exports.json"
    );

    serde_json::from_str(&body).map_err(|source| ConfigError::Parse {
        url: url.to_string(),
        source,
    })
}

/// Cache path, e.g. `~/.config/aca-cli/config.json`.
///
/// Honours `XDG_CONFIG_HOME`. Config, not cache-dir: unlike the log (which lives
/// under `XDG_CACHE_HOME`, see [`crate::telemetry::default_log_path`]) this file
/// is the thing a user would edit or delete to retarget the CLI, so the two must
/// not sit in one directory where they cannot be told apart.
pub fn cache_path() -> PathBuf {
    config_dir().join(CACHE_FILE)
}

/// Load the cache, treating a missing or unparsable file as `None` rather than
/// an error.
///
/// A stale cache must never be fatal: the file is a convenience, and an
/// older-format or half-written one has to degrade to "ask again", not to a
/// startup failure the user cannot diagnose. This tolerance is also what makes a
/// non-atomic [`save_cache`] safe.
pub fn load_cache() -> Option<AppConfig> {
    load_cache_at(&cache_path())
}

/// Persist non-secret config.
///
/// Cannot store a credential: [`AppConfig`] has no secret field, so there is
/// nothing to filter. Written `0600` inside a `0700` directory anyway — the file
/// holds no secret *by construction*, but "by construction" is a claim about
/// future code, and the permissions are the backstop.
pub fn save_cache(config: &AppConfig) -> Result<(), ConfigError> {
    save_cache_at(&cache_path(), config)
}

/// Failure to resolve a usable configuration.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// The exports URL could not be reached, or answered non-2xx.
    #[error("could not fetch {url}: {source}")]
    Fetch {
        /// The URL that was attempted.
        url: String,
        /// Underlying transport or status error.
        source: reqwest::Error,
    },
    /// The exports URL answered, but not with an `aws-exports.json`.
    #[error("{url} is not a valid aws-exports.json: {source}")]
    Parse {
        /// The URL that was fetched.
        url: String,
        /// Underlying deserialisation error.
        source: serde_json::Error,
    },
    /// Lists every missing field plus the flag that supplies it.
    #[error("incomplete configuration: {0}")]
    Incomplete(String),
    /// The cache could not be written. Never fatal — see [`resolve`].
    #[error("could not write cache at {path}: {source}")]
    CacheWrite {
        /// Path that was being written.
        path: PathBuf,
        /// Underlying IO error.
        source: std::io::Error,
    },
}

/// A partially-resolved configuration: one merge layer.
///
/// Exists so the three sources are combined by one commutative-in-shape
/// operation ([`Partial::fill_from`]) instead of five nested `or_else` chains per
/// field, which is where precedence bugs hide.
#[derive(Debug, Default, PartialEq, Eq)]
struct Partial {
    region: Option<String>,
    account_id: Option<String>,
    user_pool_id: Option<String>,
    user_pool_client_id: Option<String>,
    identity_pool_id: Option<String>,
    appsync_url: Option<String>,
}

impl Partial {
    /// The highest-precedence layer: what the user asked for explicitly.
    fn from_args(args: &crate::args::ConfigArgs) -> Self {
        Self {
            region: clean(args.region.clone()),
            account_id: clean(args.account_id.clone()),
            user_pool_id: clean(args.user_pool_id.clone()),
            user_pool_client_id: clean(args.user_pool_client_id.clone()),
            identity_pool_id: clean(args.identity_pool_id.clone()),
            appsync_url: clean(args.appsync_url.clone()),
        }
    }

    /// Adopt `other`'s values for fields this layer does not already have.
    ///
    /// Only ever fills holes, so the caller's ordering *is* the precedence: the
    /// first layer to supply a field wins permanently.
    fn fill_from(&mut self, other: Self) {
        fill(&mut self.region, other.region);
        fill(&mut self.account_id, other.account_id);
        fill(&mut self.user_pool_id, other.user_pool_id);
        fill(&mut self.user_pool_client_id, other.user_pool_client_id);
        fill(&mut self.identity_pool_id, other.identity_pool_id);
        fill(&mut self.appsync_url, other.appsync_url);
    }

    /// True when no further layer could add anything.
    ///
    /// Includes `appsync_url` even though it is optional for a *complete*
    /// config: if the user supplied an exports URL, fetching it is what they
    /// asked for, and skipping the fetch would silently disable discovery. The
    /// cache carries `appsync_url` after the first run, so this does not mean a
    /// fetch on every invocation.
    fn is_satisfied(&self) -> bool {
        self.missing().is_empty() && self.appsync_url.is_some()
    }

    /// Required fields still unknown, each rendered as `name (--flag)`.
    ///
    /// Naming the flag matters more than naming the field: a user staring at
    /// "missing account id" has to go and find which flag sets it.
    fn missing(&self) -> Vec<String> {
        [
            (&self.region, "region", "--region"),
            (&self.account_id, "AWS account id", "--account-id"),
            (&self.user_pool_id, "Cognito user pool id", "--user-pool-id"),
            (
                &self.user_pool_client_id,
                "Cognito user pool client id",
                "--user-pool-client-id",
            ),
            (
                &self.identity_pool_id,
                "Cognito identity pool id",
                "--identity-pool-id",
            ),
        ]
        .into_iter()
        .filter(|(value, _, _)| value.is_none())
        .map(|(_, label, flag)| format!("{label} ({flag})"))
        .collect()
    }

    /// Collapse into an [`AppConfig`], or report every hole at once.
    ///
    /// Reports *all* missing fields rather than the first, so a user with an
    /// empty environment fixes their invocation in one pass instead of five.
    fn into_complete(self) -> Result<AppConfig, ConfigError> {
        let missing = self.missing();
        if !missing.is_empty() {
            return Err(ConfigError::Incomplete(format!(
                "missing {}; pass --aws-exports-url to read them from the deployment",
                missing.join(", ")
            )));
        }

        // Every `expect` below is discharged by the `missing()` check above.
        Ok(AppConfig {
            region: self.region.expect("checked by missing()"),
            account_id: self.account_id.expect("checked by missing()"),
            user_pool_id: self.user_pool_id.expect("checked by missing()"),
            user_pool_client_id: self.user_pool_client_id.expect("checked by missing()"),
            identity_pool_id: self.identity_pool_id.expect("checked by missing()"),
            appsync_url: self.appsync_url,
        })
    }
}

impl From<AwsExports> for Partial {
    fn from(exports: AwsExports) -> Self {
        Self {
            region: clean(Some(exports.aws_project_region)),
            account_id: clean(Some(exports.aws_account_id)),
            user_pool_id: clean(Some(exports.aws_user_pools_id)),
            user_pool_client_id: clean(Some(exports.aws_user_pools_web_client_id)),
            identity_pool_id: clean(Some(exports.aws_cognito_identity_pool_id)),
            appsync_url: clean(exports.aws_appsync_graphqlEndpoint),
        }
    }
}

impl From<AppConfig> for Partial {
    fn from(config: AppConfig) -> Self {
        Self {
            region: Some(config.region),
            account_id: Some(config.account_id),
            user_pool_id: Some(config.user_pool_id),
            user_pool_client_id: Some(config.user_pool_client_id),
            identity_pool_id: Some(config.identity_pool_id),
            appsync_url: config.appsync_url,
        }
    }
}

/// Normalise a candidate value, treating blank as absent.
///
/// `ACA_REGION=""` (or a trailing newline from `$(...)`) would otherwise resolve
/// to an empty region and fail deep inside the SDK with an error nobody can trace
/// back to the environment.
fn clean(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Fill `slot` only if it is empty, so earlier layers win.
fn fill(slot: &mut Option<String>, value: Option<String>) {
    if slot.is_none() {
        *slot = value;
    }
}

/// Directory holding the config cache.
pub(crate) fn config_dir() -> PathBuf {
    config_dir_from(non_empty_env("XDG_CONFIG_HOME"), non_empty_env("HOME"))
}

/// Pure core of [`config_dir`], so the fallback chain is testable without
/// mutating the process environment.
///
/// Falls through `XDG_CONFIG_HOME` → `HOME/.config` → the system temp dir. The
/// last fallback exists so a missing `HOME` (containers, cron, CI) degrades to a
/// working cache rather than a startup failure: the CLI's job is to chat, not to
/// insist on a tidy environment.
fn config_dir_from(xdg_config_home: Option<String>, home: Option<String>) -> PathBuf {
    let base = xdg_config_home
        .map(PathBuf::from)
        .or_else(|| home.map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(std::env::temp_dir);
    base.join(APP_DIR)
}

/// Read an environment variable, treating blank as unset.
fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// Testable core of [`load_cache`]: every failure mode collapses to `None`.
fn load_cache_at(path: &Path) -> Option<AppConfig> {
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<AppConfig>(&raw) {
        Ok(config) => Some(config),
        Err(err) => {
            // Logged, not returned: the user gets a working run, and the reason
            // the cache was skipped is still recoverable from the log file.
            tracing::warn!("ignoring unreadable config cache {path:?}: {err}");
            None
        }
    }
}

/// Testable core of [`save_cache`].
fn save_cache_at(path: &Path, config: &AppConfig) -> Result<(), ConfigError> {
    let cache_write = |source| ConfigError::CacheWrite {
        path: path.to_path_buf(),
        source,
    };

    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        create_private_dir(parent).map_err(cache_write)?;
    }

    // Pretty-printed: this is a file users are expected to open and read when
    // they want to know which deployment the CLI is pointed at.
    let mut body = serde_json::to_vec_pretty(config).map_err(|err| cache_write(err.into()))?;
    body.push(b'\n');

    write_private_file(path, &body).map_err(cache_write)
}

/// Create `dir` (and any missing ancestors) as `0700`, mirroring
/// [`crate::telemetry`]'s log directory.
#[cfg(unix)]
pub(crate) fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;

    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

/// Create `dir` (and any missing ancestors) with platform defaults.
///
/// Non-unix targets are not a supported deployment of this CLI; this arm exists
/// only so the crate still compiles there.
#[cfg(not(unix))]
pub(crate) fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Write `body` to `path` as `0600`, tightening an existing file if needed.
#[cfg(unix)]
pub(crate) fn write_private_file(path: &Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;

    // `mode` applies only on creation, so a cache left behind by an earlier
    // version (or a looser umask) would keep its old permissions forever.
    let mut permissions = file.metadata()?.permissions();
    if permissions.mode() & 0o177 != 0 {
        permissions.set_mode(0o600);
        file.set_permissions(permissions)?;
    }

    file.write_all(body)
}

/// Write `body` to `path` with platform defaults.
///
/// Non-unix targets are not a supported deployment of this CLI; this arm exists
/// only so the crate still compiles there.
#[cfg(not(unix))]
pub(crate) fn write_private_file(path: &Path, body: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanitised copy of a deployed `aws-exports.json`.
    ///
    /// Read through `CARGO_MANIFEST_DIR` rather than `include_str!` so the test
    /// fails loudly if the fixture is deleted, instead of vanishing at compile
    /// time.
    fn fixture() -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("aws-exports.json");
        std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("read {path:?}: {err}"))
    }

    /// A complete config, for tests that need a starting point.
    fn sample_config() -> AppConfig {
        AppConfig {
            region: "us-west-2".into(),
            account_id: "123456789012".into(),
            user_pool_id: "us-west-2_CachedPool".into(),
            user_pool_client_id: "cachedclientid".into(),
            identity_pool_id: "us-west-2:cached-identity-pool".into(),
            appsync_url: Some("https://cached.appsync-api.us-west-2.amazonaws.com/graphql".into()),
        }
    }

    #[test]
    fn fixture_parses_into_a_complete_config() {
        let exports: AwsExports = serde_json::from_str(&fixture()).expect("fixture must parse");
        let config = Partial::from(exports)
            .into_complete()
            .expect("fixture must be complete");

        assert_eq!(
            config,
            AppConfig {
                region: "us-west-2".into(),
                account_id: "123456789012".into(),
                user_pool_id: "us-west-2_ExamplePool".into(),
                user_pool_client_id: "1example23client45id6789".into(),
                identity_pool_id: "us-west-2:11111111-2222-3333-4444-555555555555".into(),
                appsync_url: Some(
                    "https://example1234567890.appsync-api.us-west-2.amazonaws.com/graphql".into()
                ),
            }
        );
    }

    /// The mixed-case key is the one thing most likely to be "tidied" by a
    /// future edit, so assert the wire name directly rather than only via the
    /// whole-fixture parse.
    #[test]
    fn appsync_endpoint_reads_the_mixed_case_key() {
        let exports: AwsExports = serde_json::from_str(
            r#"{
                "aws_project_region": "eu-west-1",
                "aws_account_id": "111122223333",
                "aws_user_pools_id": "eu-west-1_Pool",
                "aws_user_pools_web_client_id": "client",
                "aws_cognito_identity_pool_id": "eu-west-1:identity",
                "aws_appsync_graphqlEndpoint": "https://graph.example/graphql"
            }"#,
        )
        .expect("parse");
        assert_eq!(
            exports.aws_appsync_graphqlEndpoint.as_deref(),
            Some("https://graph.example/graphql")
        );
    }

    /// A deployment without the optional keys must still resolve — `appsync_url`
    /// is bypassable with `--runtime-id`.
    #[test]
    fn missing_appsync_endpoint_is_tolerated() {
        let exports: AwsExports = serde_json::from_str(
            r#"{
                "aws_project_region": "eu-west-1",
                "aws_account_id": "111122223333",
                "aws_user_pools_id": "eu-west-1_Pool",
                "aws_user_pools_web_client_id": "client",
                "aws_cognito_identity_pool_id": "eu-west-1:identity"
            }"#,
        )
        .expect("parse");
        let config = Partial::from(exports).into_complete().expect("complete");
        assert_eq!(config.appsync_url, None);
    }

    /// The precedence rule itself: flags > cache > fetched exports.
    ///
    /// Exercised on the merge rather than through `resolve`, because `resolve`'s
    /// third layer is a network call — and precedence is decided entirely by the
    /// order of these `fill_from` calls, which is what this asserts.
    #[test]
    fn explicit_flags_beat_both_cache_and_exports() {
        let args = crate::args::ConfigArgs {
            region: Some("ap-southeast-2".into()),
            ..Default::default()
        };
        let exports: AwsExports = serde_json::from_str(&fixture()).expect("fixture");

        let mut partial = Partial::from_args(&args);
        partial.fill_from(Partial::from(sample_config()));
        partial.fill_from(Partial::from(exports));

        // The flag wins over both lower layers...
        assert_eq!(partial.region.as_deref(), Some("ap-southeast-2"));
        // ...the cache wins over the exports for everything the flag omitted...
        assert_eq!(
            partial.user_pool_id.as_deref(),
            Some("us-west-2_CachedPool")
        );
        // ...and one flag overrides one value, not the whole layer.
        assert_eq!(partial.account_id.as_deref(), Some("123456789012"));
    }

    /// Exports fill in whatever neither flags nor cache supplied.
    #[test]
    fn exports_supply_what_earlier_layers_omitted() {
        let mut partial = Partial::from_args(&crate::args::ConfigArgs::default());
        partial.fill_from(Partial::from(
            serde_json::from_str::<AwsExports>(&fixture()).expect("fixture"),
        ));
        assert_eq!(
            partial.user_pool_id.as_deref(),
            Some("us-west-2_ExamplePool")
        );
    }

    #[test]
    fn incomplete_config_names_every_field_and_its_flag() {
        let args = crate::args::ConfigArgs {
            region: Some("us-west-2".into()),
            account_id: Some("123456789012".into()),
            ..Default::default()
        };
        let err = Partial::from_args(&args)
            .into_complete()
            .expect_err("must be incomplete");

        let ConfigError::Incomplete(message) = &err else {
            panic!("expected Incomplete, got {err:?}");
        };
        for expected in [
            "Cognito user pool id",
            "--user-pool-id",
            "Cognito user pool client id",
            "--user-pool-client-id",
            "Cognito identity pool id",
            "--identity-pool-id",
            // The recovery hint, so the message is actionable on its own.
            "--aws-exports-url",
        ] {
            assert!(message.contains(expected), "{message:?} omits {expected:?}");
        }
        // Fields that *were* supplied must not be reported as missing.
        assert!(!message.contains("--region"), "{message:?} over-reports");
    }

    /// Blank env values are the classic `ACA_REGION=$(...)` failure; they must
    /// read as absent, not as an empty region.
    #[test]
    fn blank_and_padded_values_are_normalised() {
        let args = crate::args::ConfigArgs {
            region: Some("  ".into()),
            account_id: Some(" 123456789012\n".into()),
            ..Default::default()
        };
        let partial = Partial::from_args(&args);
        assert_eq!(partial.region, None);
        assert_eq!(partial.account_id.as_deref(), Some("123456789012"));
    }

    #[test]
    fn is_satisfied_requires_the_optional_endpoint_too() {
        let mut partial = Partial::from(sample_config());
        assert!(partial.is_satisfied());
        // Missing only the optional endpoint: still worth a fetch, because
        // skipping it would silently disable discovery.
        partial.appsync_url = None;
        assert!(!partial.is_satisfied());
    }

    #[test]
    fn cache_round_trips() {
        let dir = temp_dir();
        let path = dir.join("nested").join(CACHE_FILE);
        let config = sample_config();

        save_cache_at(&path, &config).expect("save");
        assert_eq!(load_cache_at(&path), Some(config));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "cache file is not user-only");
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The story's "a stale cache must never be fatal" rule, at its sharpest: a
    /// corrupt file is indistinguishable from no file.
    #[test]
    fn a_corrupt_or_missing_cache_reads_as_none() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join(CACHE_FILE);

        assert_eq!(load_cache_at(&path), None, "missing file must be None");

        for corrupt in ["", "{", "not json at all", r#"{"region":"us-west-2"}"#] {
            std::fs::write(&path, corrupt).expect("write");
            assert_eq!(
                load_cache_at(&path),
                None,
                "corrupt cache {corrupt:?} must be None"
            );
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Guards the type-level promise that the cache cannot hold a credential: if
    /// anyone adds a token field to `AppConfig`, this fails rather than quietly
    /// writing a secret to disk.
    #[test]
    fn cache_contents_are_exactly_the_known_non_secret_fields() {
        let value = serde_json::to_value(sample_config()).expect("serialise");
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "account_id",
                "appsync_url",
                "identity_pool_id",
                "region",
                "user_pool_client_id",
                "user_pool_id",
            ]
        );
    }

    #[test]
    fn cache_path_follows_the_config_convention() {
        let path = cache_path();
        assert!(path.ends_with("aca-cli/config.json"), "unexpected {path:?}");
        assert!(path.is_absolute(), "not absolute: {path:?}");
    }

    #[test]
    fn config_dir_falls_through_xdg_then_home() {
        assert_eq!(
            config_dir_from(Some("/xdg".into()), Some("/home/alice".into())),
            PathBuf::from("/xdg/aca-cli")
        );
        assert_eq!(
            config_dir_from(None, Some("/home/alice".into())),
            PathBuf::from("/home/alice/.config/aca-cli")
        );
        // Neither set: a temp-dir path, not a panic and not a relative path.
        let fallback = config_dir_from(None, None);
        assert!(fallback.is_absolute(), "not absolute: {fallback:?}");
        assert!(fallback.ends_with(APP_DIR));
    }

    /// Per-test scratch directory. Not created here — some tests need the
    /// "parent is missing" case.
    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("aca-cli-config-test-{}", uuid::Uuid::new_v4()))
    }
}
