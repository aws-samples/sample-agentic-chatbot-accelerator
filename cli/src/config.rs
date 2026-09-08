//! Backend identity resolution, using **no AWS credentials**.
//!
//! This is the module that makes the CLI usable by someone who has only a
//! CloudFront URL and a Cognito user. Four layers are merged, highest
//! precedence first:
//!
//! 1. **Flags / `ACA_*` env** — an explicit override always wins, so a split or
//!    hand-rolled stack can be addressed field by field.
//! 2. **The on-disk config file** — non-secret ids only, so the second run of the
//!    day needs no flags and no network.
//! 3. **The deployment's public `aws-exports.json`** — fetched over plain HTTPS
//!    with no `Authorization` header and no signature, because it is served
//!    publicly by CloudFront. That credential-free property is the whole reason
//!    this file is the config contract rather than CloudFormation outputs, whose
//!    keys are hash-suffixed and whose stack name depends on the
//!    non-git-versioned `config.yaml` (design doc decision 5 / ADR-0008).
//! 4. **Interactive setup** — a last resort, and only when stdin is a terminal. A
//!    deployment with no web UI serves no `aws-exports.json`, so layer 3 has
//!    nothing to read and asking is all that is left. Skipping this layer without
//!    a TTY is what keeps a CI run failing fast instead of blocking on a prompt.
//!
//! The fetch here is also the first real TLS connection the process makes, which
//! is why T1's throwaway `tls::smoke_check` was folded into it rather than kept:
//! a crypto-provider clash surfaces as a runtime panic, and this call site is now
//! the one that would trip it.
//!
//! Nothing in this module reads or writes a secret. [`AppConfig`] has no secret
//! field, so [`save_config`] is *structurally* incapable of persisting a token —
//! that is a type-level guarantee rather than a filter applied at write time.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Config file name inside the config directory.
///
/// JSON, not the `config.toml` the task plan named: the crate has no `toml`
/// dependency and adding one to store five strings is not worth the supply-chain
/// surface. `serde_json` is already in the graph for `aws-exports.json` itself.
const CONFIG_FILE: &str = "config.json";

/// Directory name shared by the config file and (under a different base) the log.
const APP_DIR: &str = "aca-cli";

/// Attempts allowed at a required prompt before setup gives up.
///
/// Bounded because [`crate::ui::plain::prompt_line`] cannot tell Enter from
/// Ctrl-D — both arrive as an empty line. Unbounded, an EOF at a required prompt
/// would spin forever instead of aborting.
const MAX_BLANK_ANSWERS: usize = 3;

/// Ceiling on the exports GET.
///
/// A CloudFront edge either answers in milliseconds or is unreachable; without a
/// timeout a black-holed connection would hang the CLI before it has printed
/// anything a user could interpret.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Everything the CLI needs to reach a deployment.
///
/// Every field except [`AppConfig::appsync_url`] is required. Deliberately holds
/// **no** secret: this type is what gets serialised to the config file, so keeping
/// it credential-free by construction is what makes persisting it safe.
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

/// Asks the user for one configuration field.
///
/// Behind a trait so that "a non-interactive run never prompts" is an assertion
/// about a recorded fake rather than a claim about terminal behaviour nobody can
/// test — the same seam as [`crate::discovery::Chooser`].
pub trait Prompter {
    /// Ask for `field`, showing `help` as a one-line hint. Returns the trimmed
    /// answer; an empty `String` means the user pressed Enter.
    fn ask(&self, field: &str, help: &str) -> Result<String, ConfigError>;
}

/// Reads answers from the terminal, prompting on stderr.
pub struct TerminalPrompter;

impl Prompter for TerminalPrompter {
    fn ask(&self, field: &str, help: &str) -> Result<String, ConfigError> {
        // Every read failure at a prompt is EOF or a signal; there is no case
        // worth reporting separately, and none worth retrying.
        crate::ui::plain::prompt_line(&format!("{field} ({help}): "))
            .map_err(|_| ConfigError::Aborted)
    }
}

/// True when stdin is a terminal, i.e. when prompting can succeed at all.
///
/// stdin specifically, not stdout: a run whose output is piped to a file is still
/// interactive, and refusing to prompt there would break `aca -m "..." > out.txt`
/// on a fresh machine.
pub(crate) fn stdin_is_tty() -> bool {
    std::io::stdin().is_terminal()
}

/// Resolve config with precedence: flags/env > config file > fetched exports >
/// interactive setup.
///
/// Performs an unauthenticated HTTPS GET when `--aws-exports-url` is set and the
/// needed fields aren't already supplied — so a warm config file means no network
/// call at all. Writes the resolved **non-secret** fields back unless
/// `--no-cache`.
///
/// Errors when the merged result is still missing a required field, naming every
/// missing field and the flag that would supply it. A failed write is **not** an
/// error: being unable to memoise five ids is no reason to refuse to chat, so it
/// is logged and ignored.
pub async fn resolve(args: &crate::args::ConfigArgs) -> Result<AppConfig, ConfigError> {
    if stdin_is_tty() {
        resolve_with(args, Some(&TerminalPrompter)).await
    } else {
        resolve_with(args, None).await
    }
}

/// [`resolve`] with the prompt surface injected.
///
/// `prompter` is `None` for a non-interactive run: layer 4 is skipped entirely, so
/// the merged result must stand on its own and the error is
/// [`ConfigError::Incomplete`]. That is the regression the tests exist to prevent.
pub(crate) async fn resolve_with(
    args: &crate::args::ConfigArgs,
    prompter: Option<&dyn Prompter>,
) -> Result<AppConfig, ConfigError> {
    resolve_at(&config_path(), args, prompter).await
}

/// Testable core of [`resolve_with`]: every filesystem access goes through `path`.
async fn resolve_at(
    path: &Path,
    args: &crate::args::ConfigArgs,
    prompter: Option<&dyn Prompter>,
) -> Result<AppConfig, ConfigError> {
    let mut partial = Partial::from_args(args);

    // The config file is consulted before the network, per the specified
    // precedence. Known consequence: pointing `--aws-exports-url` at a
    // *different* deployment while a complete config exists resolves the stored
    // one, because no field is left for the fetch to supply. `--no-cache` is the
    // escape hatch; the file is not keyed by source URL because `save_config`
    // takes an `AppConfig`, which has nowhere to record one.
    let stored = if args.no_cache {
        None
    } else {
        load_config_at(path)
    };
    if let Some(stored) = stored.clone() {
        partial.fill_from(Partial::from(stored));
    }

    if !partial.is_satisfied()
        && let Some(url) = clean(args.aws_exports_url.clone())
    {
        partial.fill_from(Partial::from(fetch_exports(&url).await?));
    }

    // Layer 4, before `into_complete()` rather than after a failure: an
    // interactive run fills the holes, a non-interactive one keeps today's
    // `Incomplete` error.
    if let Some(prompter) = prompter.filter(|_| !partial.missing().is_empty()) {
        interactive_setup(&mut partial, prompter).await?;
    }

    let config = partial.into_complete()?;

    // Skip a no-op write so a steady-state run touches the filesystem zero times.
    if !args.no_cache
        && stored.as_ref() != Some(&config)
        && let Err(err) = save_config_at(path, &config)
    {
        tracing::warn!("config file not updated: {err}");
    }

    Ok(config)
}

/// Fill whatever is still missing by asking, in place.
///
/// The exports URL is offered first, so a deployment *with* a web UI keeps its
/// one-question bootstrap. A blank answer, or a fetch that fails, falls through to
/// per-field prompts instead of aborting: a stale URL should not strand someone
/// who can still name the ids.
///
/// Pure with respect to the filesystem — writing is [`resolve_at`]'s job, so
/// `--no-cache` suppresses the write without suppressing the prompts.
async fn interactive_setup(
    partial: &mut Partial,
    prompter: &dyn Prompter,
) -> Result<(), ConfigError> {
    eprintln!("aca needs to know which deployment to reach.");

    let url = prompter.ask(
        "aws-exports.json URL",
        "blank if this deployment has no web UI",
    )?;
    if let Some(url) = clean(Some(url)) {
        match fetch_exports(&url).await {
            Ok(exports) => partial.fill_from(Partial::from(exports)),
            // Reported and then ignored: the prompts below can still produce a
            // usable config, so a URL that has gone stale costs one question
            // rather than the whole run.
            Err(err) => eprintln!("aca: {err}"),
        }
    }

    for (slot, field, help) in [
        (&mut partial.region, "region", "e.g. us-west-2"),
        (&mut partial.account_id, "AWS account id", "12 digits"),
        (
            &mut partial.user_pool_id,
            "Cognito user pool id",
            "e.g. us-west-2_AbCdEfGhI",
        ),
        (
            &mut partial.user_pool_client_id,
            "Cognito user pool client id",
            "the app client with USER_PASSWORD_AUTH enabled",
        ),
        (
            &mut partial.identity_pool_id,
            "Cognito identity pool id",
            "e.g. us-west-2:11111111-2222-3333-4444-555555555555",
        ),
    ] {
        if slot.is_none() {
            *slot = Some(ask_required(prompter, field, help)?);
        }
    }

    if partial.appsync_url.is_none() {
        partial.appsync_url = clean(Some(prompter.ask(
            "AppSync GraphQL endpoint",
            "optional — blank if this deployment has none",
        )?));
        if partial.appsync_url.is_none() {
            eprintln!(
                "aca: `aca agents` needs AppSync, so it is unavailable — \
                 pass --runtime-id and --qualifier to reach a runtime directly"
            );
        }
    }

    Ok(())
}

/// Ask until a non-blank answer arrives, or [`MAX_BLANK_ANSWERS`] have been.
///
/// Blank is re-asked rather than accepted because [`clean`] treats it as absent,
/// and a config that stored one would fail much later, deep inside the SDK.
fn ask_required(prompter: &dyn Prompter, field: &str, help: &str) -> Result<String, ConfigError> {
    for _ in 0..MAX_BLANK_ANSWERS {
        if let Some(value) = clean(Some(prompter.ask(field, help)?)) {
            return Ok(value);
        }
        eprintln!("aca: {field} is required");
    }
    Err(ConfigError::Aborted)
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

/// Config file path, e.g. `~/.config/aca-cli/config.json`.
///
/// Honours `XDG_CONFIG_HOME`. Config, not cache-dir: unlike the log (which lives
/// under `XDG_CACHE_HOME`, see [`crate::telemetry::default_log_path`]) this file
/// is the thing a user would edit or delete to retarget the CLI, so the two must
/// not sit in one directory where they cannot be told apart.
pub fn config_path() -> PathBuf {
    config_dir().join(CONFIG_FILE)
}

/// Load the config file, treating a missing or unparsable one as `None` rather
/// than an error.
///
/// A stale config must never be fatal: an older-format or half-written file has to
/// degrade to "ask again", not to a startup failure the user cannot diagnose. This
/// tolerance is also what makes a non-atomic [`save_config`] safe.
pub fn load_config() -> Option<AppConfig> {
    load_config_at(&config_path())
}

/// Persist non-secret config.
///
/// Cannot store a credential: [`AppConfig`] has no secret field, so there is
/// nothing to filter. Written `0600` inside a `0700` directory anyway — the file
/// holds no secret *by construction*, but "by construction" is a claim about
/// future code, and the permissions are the backstop.
pub fn save_config(config: &AppConfig) -> Result<(), ConfigError> {
    save_config_at(&config_path(), config)
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
    /// The config file could not be written. Never fatal — see [`resolve`].
    #[error("could not write the config file at {path}: {source}")]
    CacheWrite {
        /// Path that was being written.
        path: PathBuf,
        /// Underlying IO error.
        source: std::io::Error,
    },
    /// Interactive setup was ended by the user (EOF or interrupt). Nothing was
    /// written: a partly-answered config is worse than none.
    #[error("configuration setup abandoned; nothing was saved")]
    Aborted,
}

/// A partially-resolved configuration: one merge layer.
///
/// Exists so the sources are combined by one commutative-in-shape
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
    /// config file carries `appsync_url` after the first run, so this does not
    /// mean a fetch on every invocation.
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
        // Cleaned like every other layer: the config file is hand-editable, and a
        // field blanked out in it has to read as absent — so that the field, and
        // only that field, is asked for again.
        Self {
            region: clean(Some(config.region)),
            account_id: clean(Some(config.account_id)),
            user_pool_id: clean(Some(config.user_pool_id)),
            user_pool_client_id: clean(Some(config.user_pool_client_id)),
            identity_pool_id: clean(Some(config.identity_pool_id)),
            appsync_url: clean(config.appsync_url),
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

/// Directory holding the config file.
pub(crate) fn config_dir() -> PathBuf {
    config_dir_from(non_empty_env("XDG_CONFIG_HOME"), non_empty_env("HOME"))
}

/// Pure core of [`config_dir`], so the fallback chain is testable without
/// mutating the process environment.
///
/// Falls through `XDG_CONFIG_HOME` → `HOME/.config` → the system temp dir. The
/// last fallback exists so a missing `HOME` (containers, cron, CI) degrades to a
/// working config file rather than a startup failure: the CLI's job is to chat,
/// not to insist on a tidy environment.
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

/// Testable core of [`load_config`]: every failure mode collapses to `None`.
fn load_config_at(path: &Path) -> Option<AppConfig> {
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<AppConfig>(&raw) {
        Ok(config) => Some(config),
        Err(err) => {
            // Logged, not returned: the user gets a working run, and the reason
            // the file was skipped is still recoverable from the log file.
            tracing::warn!("ignoring unreadable config file {path:?}: {err}");
            None
        }
    }
}

/// Testable core of [`save_config`].
fn save_config_at(path: &Path, config: &AppConfig) -> Result<(), ConfigError> {
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

    // `mode` applies only on creation, so a file left behind by an earlier
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
    use std::cell::RefCell;

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
        let path = dir.join("nested").join(CONFIG_FILE);
        let config = sample_config();

        save_config_at(&path, &config).expect("save");
        assert_eq!(load_config_at(&path), Some(config));

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
        let path = dir.join(CONFIG_FILE);

        assert_eq!(load_config_at(&path), None, "missing file must be None");

        for corrupt in ["", "{", "not json at all", r#"{"region":"us-west-2"}"#] {
            std::fs::write(&path, corrupt).expect("write");
            assert_eq!(
                load_config_at(&path),
                None,
                "corrupt config {corrupt:?} must be None"
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
    fn config_path_follows_the_config_convention() {
        let path = config_path();
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

    /// Scratch config path in a directory that does not exist yet.
    fn temp_config_path() -> PathBuf {
        temp_dir().join(CONFIG_FILE)
    }

    fn cleanup(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::remove_dir_all(parent).ok();
        }
    }

    /// Answers from a script, recording what it was asked.
    ///
    /// An exhausted script answers [`ConfigError::Aborted`], which is what EOF
    /// looks like — so the abort path is a script that runs out.
    struct ScriptedPrompter {
        answers: RefCell<std::collections::VecDeque<String>>,
        asked: RefCell<Vec<String>>,
    }

    impl ScriptedPrompter {
        fn answering(answers: &[&str]) -> Self {
            Self {
                answers: RefCell::new(answers.iter().map(|answer| answer.to_string()).collect()),
                asked: RefCell::new(Vec::new()),
            }
        }

        fn asked(&self) -> Vec<String> {
            self.asked.borrow().clone()
        }

        fn times_asked(&self, field: &str) -> usize {
            self.asked()
                .iter()
                .filter(|asked| asked.contains(field))
                .count()
        }
    }

    impl Prompter for ScriptedPrompter {
        fn ask(&self, field: &str, _help: &str) -> Result<String, ConfigError> {
            self.asked.borrow_mut().push(field.to_string());
            self.answers
                .borrow_mut()
                .pop_front()
                .ok_or(ConfigError::Aborted)
        }
    }

    /// Panics if consulted — the way "never prompts" is asserted.
    struct NeverPrompter;

    impl Prompter for NeverPrompter {
        fn ask(&self, field: &str, _help: &str) -> Result<String, ConfigError> {
            panic!("must not prompt: asked for {field}");
        }
    }

    /// Answers one request with a 404 and an HTML body, on a loopback port.
    ///
    /// A server that answers, not an unreachable host: the case that matters is a
    /// UI-off deployment whose CloudFront URL still resolves.
    fn serve_one_404() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!(
            "http://{}/aws-exports.json",
            listener.local_addr().expect("addr")
        );
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                use std::io::{Read, Write};

                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let body = "<html>Not Found</html>";
                let _ = write!(
                    stream,
                    "HTTP/1.1 404 Not Found\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        url
    }

    /// The answers a full setup needs, exports URL first.
    const FULL_SETUP: &[&str] = &[
        "",
        "eu-west-1",
        "111122223333",
        "eu-west-1_Pool",
        "envclient",
        "eu-west-1:env-identity",
        "https://graph.example/graphql",
    ];

    /// What [`FULL_SETUP`] resolves to.
    fn prompted_config() -> AppConfig {
        AppConfig {
            region: "eu-west-1".into(),
            account_id: "111122223333".into(),
            user_pool_id: "eu-west-1_Pool".into(),
            user_pool_client_id: "envclient".into(),
            identity_pool_id: "eu-west-1:env-identity".into(),
            appsync_url: Some("https://graph.example/graphql".into()),
        }
    }

    /// The sharpest regression risk in the story: with no prompter there is no
    /// layer 4, so the run fails with the field list rather than blocking on a
    /// question CI could never answer.
    #[tokio::test]
    async fn a_run_without_a_prompter_reports_every_missing_field() {
        let path = temp_config_path();
        let args = crate::args::ConfigArgs {
            region: Some("us-west-2".into()),
            ..Default::default()
        };

        let err = resolve_at(&path, &args, None).await.expect_err("must fail");
        let ConfigError::Incomplete(message) = &err else {
            panic!("expected Incomplete, got {err:?}");
        };
        for expected in [
            "AWS account id",
            "--account-id",
            "Cognito user pool id",
            "--user-pool-id",
            "Cognito user pool client id",
            "--user-pool-client-id",
            "Cognito identity pool id",
            "--identity-pool-id",
            "--aws-exports-url",
        ] {
            assert!(message.contains(expected), "{message:?} omits {expected:?}");
        }
        assert!(!path.exists(), "a failed resolve must leave nothing behind");
        cleanup(&path);
    }

    #[tokio::test]
    async fn a_complete_config_file_is_never_prompted_for() {
        let path = temp_config_path();
        save_config_at(&path, &sample_config()).expect("seed");

        let config = resolve_at(
            &path,
            &crate::args::ConfigArgs::default(),
            Some(&NeverPrompter),
        )
        .await
        .expect("the file alone is enough");

        assert_eq!(config, sample_config());
        cleanup(&path);
    }

    #[tokio::test]
    async fn setup_prompts_fill_the_config_and_persist_it_privately() {
        let path = temp_config_path();
        let prompter = ScriptedPrompter::answering(FULL_SETUP);

        let config = resolve_at(&path, &crate::args::ConfigArgs::default(), Some(&prompter))
            .await
            .expect("prompts must complete the config");

        assert_eq!(config, prompted_config());
        // The exports URL is offered first, so a deployment with a web UI is one
        // question rather than six.
        assert!(
            prompter.asked()[0].contains("aws-exports.json"),
            "{:?}",
            prompter.asked()
        );
        assert_eq!(load_config_at(&path), Some(prompted_config()));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "written config is not user-only");
        }

        cleanup(&path);
    }

    /// `--no-cache` has always meant "do not persist", not "do not ask".
    #[tokio::test]
    async fn no_cache_prompts_but_writes_nothing() {
        let path = temp_config_path();
        let prompter = ScriptedPrompter::answering(FULL_SETUP);
        let args = crate::args::ConfigArgs {
            no_cache: true,
            ..Default::default()
        };

        let config = resolve_at(&path, &args, Some(&prompter))
            .await
            .expect("prompts must still run");

        assert_eq!(config, prompted_config());
        assert!(!prompter.asked().is_empty(), "prompts were suppressed");
        assert!(!path.exists(), "--no-cache must write nothing");
        cleanup(&path);
    }

    #[tokio::test]
    async fn a_blank_required_answer_is_re_asked_and_a_blank_appsync_is_accepted() {
        let path = temp_config_path();
        let prompter = ScriptedPrompter::answering(&[
            "",
            // Enter at a required prompt: asked again rather than stored as an
            // empty region.
            "  ",
            "eu-west-1",
            "111122223333",
            "eu-west-1_Pool",
            "envclient",
            "eu-west-1:env-identity",
            "",
        ]);

        let config = resolve_at(&path, &crate::args::ConfigArgs::default(), Some(&prompter))
            .await
            .expect("a blank must not be fatal");

        assert_eq!(config.region, "eu-west-1");
        assert_eq!(prompter.times_asked("region"), 2);
        assert_eq!(config.appsync_url, None, "blank AppSync means absent");
        cleanup(&path);
    }

    /// A config file is hand-editable, so a field blanked out in it reads as
    /// absent — and only that field is asked for.
    #[tokio::test]
    async fn a_config_file_with_one_blank_field_prompts_for_that_field_only() {
        let path = temp_config_path();
        save_config_at(
            &path,
            &AppConfig {
                region: String::new(),
                ..sample_config()
            },
        )
        .expect("seed");
        let prompter = ScriptedPrompter::answering(&["", "eu-west-1"]);

        let config = resolve_at(&path, &crate::args::ConfigArgs::default(), Some(&prompter))
            .await
            .expect("the hole is fillable");

        assert_eq!(config.region, "eu-west-1");
        assert_eq!(config.user_pool_id, sample_config().user_pool_id);
        assert_eq!(prompter.times_asked("region"), 1);
        assert_eq!(prompter.asked().len(), 2, "{:?}", prompter.asked());
        cleanup(&path);
    }

    /// The existing tolerance, now with somewhere to land: a corrupt file reads as
    /// absent and setup asks instead of failing.
    #[tokio::test]
    async fn a_corrupt_config_file_is_replaced_by_what_the_prompts_collect() {
        let path = temp_config_path();
        create_private_dir(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, "{ half-written").expect("write");
        let prompter = ScriptedPrompter::answering(FULL_SETUP);

        let config = resolve_at(&path, &crate::args::ConfigArgs::default(), Some(&prompter))
            .await
            .expect("a corrupt file must never be fatal");

        assert_eq!(config, prompted_config());
        assert_eq!(load_config_at(&path), Some(prompted_config()));
        cleanup(&path);
    }

    /// A stale UI-off URL costs one question, not the run.
    #[tokio::test]
    async fn a_prompted_exports_url_that_404s_falls_through_to_per_field_prompts() {
        let path = temp_config_path();
        let url = serve_one_404();
        let mut answers = vec![url.as_str()];
        answers.extend(FULL_SETUP.iter().skip(1).copied());
        let prompter = ScriptedPrompter::answering(&answers);

        let config = resolve_at(&path, &crate::args::ConfigArgs::default(), Some(&prompter))
            .await
            .expect("a failed fetch must fall through, not abort");

        assert_eq!(config, prompted_config());
        assert_eq!(prompter.times_asked("region"), 1);
        cleanup(&path);
    }

    /// EOF mid-setup: nothing is written, and the failure is not mistaken for
    /// success. `dispatch` maps every `ConfigError` to `exit::CONFIG`.
    #[tokio::test]
    async fn an_abandoned_setup_writes_nothing() {
        let path = temp_config_path();
        // A script that runs out at the first question is a user pressing Ctrl-D.
        let prompter = ScriptedPrompter::answering(&[]);

        let err = resolve_at(&path, &crate::args::ConfigArgs::default(), Some(&prompter))
            .await
            .expect_err("must not resolve");

        assert!(matches!(err, ConfigError::Aborted), "{err:?}");
        assert!(!path.exists(), "an abandoned setup must write nothing");
        cleanup(&path);
    }

    /// Blank and EOF are indistinguishable through `prompt_line`, so a required
    /// prompt gives up rather than spinning forever.
    #[tokio::test]
    async fn endless_blank_answers_abort_instead_of_looping() {
        let path = temp_config_path();
        let blanks = vec![""; MAX_BLANK_ANSWERS + 1];
        let prompter = ScriptedPrompter::answering(&blanks);

        let err = resolve_at(&path, &crate::args::ConfigArgs::default(), Some(&prompter))
            .await
            .expect_err("must not loop");

        assert!(matches!(err, ConfigError::Aborted), "{err:?}");
        assert_eq!(prompter.times_asked("region"), MAX_BLANK_ANSWERS);
        assert!(!path.exists());
        cleanup(&path);
    }
}
