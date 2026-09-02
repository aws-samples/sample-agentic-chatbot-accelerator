//! Logging and secret-handling baseline.
//!
//! This module is a leaf that every other module depends on, and it lands
//! before any module handles a token so that no later task can accidentally
//! leak one. Three guarantees live here:
//!
//! 1. Diagnostics go to a file and nowhere else — stdout belongs to the chat
//!    transcript (T10) or the TUI (T11).
//! 2. Anything credential-shaped is wrapped in [`Secret`], whose `Debug` and
//!    `Display` cannot render it, so `{:?}` on a struct full of tokens is safe.
//! 3. A presigned URL is only ever logged through [`redact_presigned_url`],
//!    because the URL itself is a bearer credential.

use std::fs::File;
use std::path::{Path, PathBuf};

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, fmt};

/// Environment variable that overrides the log filter.
///
/// Deliberately *not* `RUST_LOG`: a developer with `RUST_LOG=debug` exported for
/// some unrelated crate should not silently start writing another tool's debug
/// output into this file.
const LOG_ENV: &str = "ACA_CLI_LOG";

/// Default filter: informative for our own spans, quiet for the dependency tree.
///
/// `info` across the whole graph would drown the file in rustls/hyper/AWS-SDK
/// chatter and make the one line that matters unfindable.
const DEFAULT_FILTER: &str = "warn,aca_cli=info";

/// Query parameters worth keeping when redacting a presigned URL.
///
/// `qualifier` selects which runtime *version* was addressed, which is the
/// single most useful thing to know when a handshake fails, and it carries no
/// secret. Everything else in the query string is dropped — see
/// [`redact_presigned_url`] for why the allowlist runs this way round.
const REDACTION_ALLOWLIST: &[&str] = &["qualifier"];

/// Initialise a file-only tracing subscriber.
///
/// There is deliberately **no** stdout/stderr layer, not even at `error` level:
/// stdout belongs to the chat transcript (T10) or the TUI (T11), and a stray log
/// line would both corrupt the transcript and risk leaking a credential. Error
/// paths print a deliberate, redacted, user-facing message instead.
///
/// `log_path` defaults to [`default_log_path`]. The file and its parent
/// directory are created with user-only permissions before the appender ever
/// sees them.
///
/// Returns a guard that must be held for the process lifetime; dropping it
/// early loses buffered lines, because the writer is non-blocking and flushes on
/// the guard's `Drop`.
pub fn init(
    log_path: Option<PathBuf>,
) -> anyhow::Result<tracing_appender::non_blocking::WorkerGuard> {
    let path = log_path.unwrap_or_else(default_log_path);
    let file = open_log_file(&path)?;
    let (filter, filter_warning) = build_filter();

    // `non_blocking` moves the file onto a worker thread; the returned guard is
    // the only thing that flushes it, hence the caller's obligation to hold it.
    let (writer, guard) = tracing_appender::non_blocking(file);

    tracing_subscriber::registry()
        .with(filter)
        // No ANSI: the sink is a file, and escape codes make `grep` useless.
        .with(fmt::layer().with_writer(writer).with_ansi(false))
        .try_init()
        .map_err(|err| anyhow::anyhow!("a tracing subscriber was already installed: {err}"))?;

    // Reported here rather than at parse time because complaining about a bad
    // filter on stderr is exactly the leak-prone behaviour this module forbids.
    if let Some(warning) = filter_warning {
        tracing::warn!("{LOG_ENV} ignored: {warning}; using {DEFAULT_FILTER:?}");
    }

    Ok(guard)
}

/// Default log location, e.g. `~/.cache/aca-cli/aca.log`. Created with
/// user-only permissions.
///
/// Follows `XDG_CACHE_HOME` when set. The log is a cache, not config: it is
/// disposable, so it must not sit next to T4's config cache in
/// `~/.config/aca-cli/` where a user cleaning up state could not tell the two
/// apart.
pub fn default_log_path() -> PathBuf {
    log_dir().join("aca.log")
}

/// Resolve the directory holding the log file.
///
/// Falls back through `XDG_CACHE_HOME` → `HOME/.cache` → the system temp dir.
/// The last fallback exists so that a missing `HOME` (containers, cron, CI)
/// degrades to a working log rather than a startup failure — the CLI's job is to
/// chat, not to insist on a tidy environment.
fn log_dir() -> PathBuf {
    let base = non_empty_env("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| non_empty_env("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("aca-cli")
}

/// Read an environment variable, treating blank as unset.
///
/// An exported-but-empty `HOME` would otherwise resolve the log path to
/// `/.cache/aca-cli`, which fails to create for a reason the user cannot guess.
fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// Build the filter, deferring any parse complaint to the caller.
///
/// Returns the filter plus an optional message describing why the environment
/// override was rejected. `EnvFilter`'s own lossy parser writes warnings to
/// stderr, which this module must never do, so parsing is strict here and the
/// fallback is silent until [`init`] can log it to the file.
fn build_filter() -> (EnvFilter, Option<String>) {
    let default = || EnvFilter::new(DEFAULT_FILTER);
    match non_empty_env(LOG_ENV) {
        None => (default(), None),
        Some(directives) => match EnvFilter::builder().parse(&directives) {
            Ok(filter) => (filter, None),
            Err(err) => (default(), Some(err.to_string())),
        },
    }
}

/// Open the log file for appending, creating it and its parent with
/// user-only permissions.
///
/// `tracing-appender` creates files with the process umask, which on a shared
/// host can leave them group- or world-readable. The log contains no secrets by
/// construction, but "by construction" is a claim about future code, so the
/// permissions are the backstop.
fn open_log_file(path: &Path) -> anyhow::Result<File> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        create_private_dir(parent)
            .map_err(|err| anyhow::anyhow!("cannot create log directory {parent:?}: {err}"))?;
    }
    open_private_file(path).map_err(|err| anyhow::anyhow!("cannot open log file {path:?}: {err}"))
}

/// Create `dir` (and any missing ancestors) as `0700`.
#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
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
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Open `path` append-only as `0600`, tightening an existing file if needed.
#[cfg(unix)]
fn open_private_file(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?;

    // `mode` applies only on creation, so a log left behind by an earlier
    // version (or a looser umask) would keep its old permissions forever.
    let mut permissions = file.metadata()?.permissions();
    if permissions.mode() & 0o177 != 0 {
        permissions.set_mode(0o600);
        file.set_permissions(permissions)?;
    }
    Ok(file)
}

/// Open `path` append-only with platform defaults.
///
/// Non-unix targets are not a supported deployment of this CLI; this arm exists
/// only so the crate still compiles there.
#[cfg(not(unix))]
fn open_private_file(path: &Path) -> std::io::Result<File> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
}

/// Install a panic hook that runs `restore` (terminal teardown) before the
/// default hook prints the panic message.
///
/// Without this, a panic inside the ratatui alternate screen (T11) leaves the
/// terminal unusable and the backtrace unreadable. `restore` runs first so the
/// default hook's stderr output lands on a cooked terminal; the panic is also
/// mirrored into the log file, which is the only place a backtrace survives once
/// the TUI has scrolled it away.
pub fn install_panic_hook(restore: impl Fn() + Send + Sync + 'static) {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        restore();
        tracing::error!("panic: {panic_info}");
        default_hook(panic_info);
    }));
}

/// A value that must never be rendered.
///
/// `Debug` and `Display` both print `[redacted]`, so a derived `Debug` on any
/// struct holding one is safe to log. Access is explicit via [`Secret::expose`],
/// which is the only way to read the inner value — that makes every leak site
/// grep-able. Zeroizes on drop.
///
/// The [`zeroize::Zeroize`] bound means `String` works and `&str` does not: a
/// secret this type cannot scrub is a secret it cannot protect, so borrowed
/// secrets are rejected at compile time rather than silently left in memory.
///
/// Nothing in the binary wraps a secret *yet* — the first real values arrive in
/// T7 (password, ID / access / refresh tokens) and T8 (STS secret key + session
/// token) — so the constructor and reader below are dead code in a non-test
/// build. They carry `expect` rather than `allow`, so the attribute itself
/// becomes a build error the moment that stops being true; `not(test)` because
/// the tests at the bottom of this file do exercise them.
pub struct Secret<T: zeroize::Zeroize>(T);

impl<T: zeroize::Zeroize> Secret<T> {
    /// Wrap a value, taking ownership so it can be zeroized on drop.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "first wrapped values land in T7 and T8")
    )]
    pub fn new(value: T) -> Self {
        Self(value)
    }

    /// Borrow the secret. Every call site is a potential leak — justify it.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "first wrapped values land in T7 and T8")
    )]
    pub fn expose(&self) -> &T {
        &self.0
    }
}

/// Renders `[redacted]`, so `{:?}` on a struct of tokens leaks nothing.
impl<T: zeroize::Zeroize> std::fmt::Debug for Secret<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}

/// Renders `[redacted]`, so `{}` in a `tracing` field leaks nothing either.
impl<T: zeroize::Zeroize> std::fmt::Display for Secret<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}

/// Scrubs the wrapped value, so a freed token is not left readable in the heap.
impl<T: zeroize::Zeroize> Drop for Secret<T> {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Redact the signature-bearing query parameters of a presigned URL, keeping
/// enough (scheme, host, path, `qualifier`) to be diagnostically useful.
///
/// The full presigned URL is a bearer credential: anyone holding it can invoke
/// the runtime as this user until it expires. Log only the output of this
/// function, never the URL itself.
///
/// The filter is an **allowlist**, not a denylist of `X-Amz-*` names: a denylist
/// would leak the day a signer adds a parameter nobody thought to list. Input is
/// treated as opaque text — a malformed URL yields a redacted string, never a
/// panic.
pub fn redact_presigned_url(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return url.to_string();
    };

    let mut kept: Vec<&str> = Vec::new();
    let mut dropped = false;
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let name = pair.split_once('=').map_or(pair, |(name, _)| name);
        if REDACTION_ALLOWLIST
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(name))
        {
            kept.push(pair);
        } else {
            dropped = true;
        }
    }

    if dropped {
        kept.push("[redacted]");
    }
    if kept.is_empty() {
        return base.to_string();
    }
    format!("{base}?{}", kept.join("&"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A shape-accurate AgentCore presigned URL. The signature, credential and
    /// session-token values are fabricated but structurally realistic.
    ///
    /// The access-key id deliberately avoids the real `AKIA`/`ASIA` prefixes:
    /// Code Defender's pre-commit secret scanner matches on those and blocks the
    /// commit, and SigV4 does not care about the key's shape. Keep every test
    /// credential in this crate prefix-free for the same reason.
    const PRESIGNED: &str = concat!(
        "wss://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/",
        "arn%3Aaws%3Abedrock-agentcore%3Aus-west-2%3A123456789012%3Aruntime%2Fmy_agent-AbCdEf/ws",
        "?qualifier=DEFAULT",
        "&X-Amz-Algorithm=AWS4-HMAC-SHA256",
        "&X-Amz-Credential=NOTAREALKEYIDFORTESTS%2F20260902%2Fus-west-2%2Fbedrock-agentcore%2Faws4_request",
        "&X-Amz-Date=20260902T101112Z",
        "&X-Amz-Expires=300",
        "&X-Amz-Security-Token=IQoJb3JpZ2luX2VjEXAMPLESESSIONTOKENVALUE%3D%3D",
        "&X-Amz-SignedHeaders=host",
        "&X-Amz-Signature=1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
    );

    const SIGNATURE: &str = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809";
    const SESSION_TOKEN: &str = "IQoJb3JpZ2luX2VjEXAMPLESESSIONTOKENVALUE";
    const ACCESS_KEY: &str = "NOTAREALKEYIDFORTESTS";

    #[test]
    fn secret_debug_and_display_reveal_nothing() {
        let secret = Secret::new(String::from("hunter2"));

        for rendered in [format!("{secret:?}"), format!("{secret}")] {
            assert_eq!(rendered, "[redacted]");
            // Not just "!= hunter2": no fragment of the secret may survive,
            // which is what would happen with a truncating redactor.
            for len in 1..="hunter2".len() {
                let fragment = &"hunter2"[..len];
                assert!(
                    !rendered.contains(fragment),
                    "rendered {rendered:?} leaks fragment {fragment:?}"
                );
            }
        }

        // The only sanctioned reader still works.
        assert_eq!(secret.expose(), "hunter2");
    }

    #[test]
    fn secret_debug_is_transitive_through_a_derived_debug() {
        // The point of the wrapper: a struct can derive Debug and stay safe.
        #[derive(Debug)]
        struct Tokens {
            username: String,
            id_token: Secret<String>,
        }

        let tokens = Tokens {
            username: "alice".into(),
            id_token: Secret::new("eyJraWQiOiJzZWNyZXQi".into()),
        };

        let rendered = format!("{tokens:?}");
        assert!(rendered.contains(&tokens.username));
        assert!(!rendered.contains("eyJ"));
        // ...while the value itself is still reachable through the one reader.
        assert!(tokens.id_token.expose().starts_with("eyJ"));
    }

    #[test]
    fn redaction_strips_every_signing_parameter() {
        let redacted = redact_presigned_url(PRESIGNED);

        assert!(!redacted.contains(SIGNATURE), "signature survived");
        assert!(!redacted.contains(SESSION_TOKEN), "session token survived");
        assert!(!redacted.contains(ACCESS_KEY), "access key survived");
        for name in [
            "X-Amz-Signature",
            "X-Amz-Credential",
            "X-Amz-Security-Token",
        ] {
            assert!(!redacted.contains(name), "{name} survived");
        }
    }

    #[test]
    fn redaction_keeps_what_makes_a_failure_diagnosable() {
        let redacted = redact_presigned_url(PRESIGNED);

        assert!(redacted.starts_with("wss://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/"));
        assert!(redacted.contains("my_agent-AbCdEf/ws"));
        assert!(redacted.contains("qualifier=DEFAULT"));
        assert!(redacted.contains("[redacted]"));
    }

    #[test]
    fn redaction_never_panics_on_malformed_input() {
        // Each of these has bitten a naive split/unwrap implementation.
        for input in [
            "",
            "?",
            "??",
            "&",
            "wss://host/path",
            "wss://host/path?",
            "wss://host/path?&&",
            "wss://host/path?=novalue",
            "wss://host/path?qualifier",
            "not a url at all",
            "?X-Amz-Signature=abc",
        ] {
            let redacted = redact_presigned_url(input);
            assert!(
                !redacted.contains("abc"),
                "{input:?} leaked a signature value"
            );
        }
    }

    #[test]
    fn redaction_leaves_a_query_less_url_alone() {
        assert_eq!(
            redact_presigned_url("https://example.cloudfront.net/aws-exports.json"),
            "https://example.cloudfront.net/aws-exports.json"
        );
    }

    #[test]
    fn default_log_path_follows_the_cache_convention() {
        let path = default_log_path();
        assert!(path.ends_with("aca-cli/aca.log"), "unexpected {path:?}");
        assert!(path.is_absolute(), "not absolute: {path:?}");
    }

    /// The whole point of the module: log lines reach the file and nothing else.
    ///
    /// This is the only test that installs the global subscriber, so it must
    /// stay the only one — a second `init` in this binary would fail.
    #[test]
    fn subscriber_writes_only_to_a_private_file() {
        let dir = std::env::temp_dir().join(format!("aca-cli-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested").join("aca.log");

        let guard = init(Some(path.clone())).expect("init");
        tracing::info!(marker = "canary", "telemetry smoke line");
        // Flush: the writer is non-blocking, so the line is still in the queue.
        drop(guard);

        let contents = std::fs::read_to_string(&path).expect("log file");
        assert!(contents.contains("canary"), "missing line in {contents:?}");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let file_mode = std::fs::metadata(&path)
                .expect("stat file")
                .permissions()
                .mode();
            assert_eq!(file_mode & 0o777, 0o600, "log file is not user-only");

            let dir_mode = std::fs::metadata(path.parent().expect("parent"))
                .expect("stat dir")
                .permissions()
                .mode();
            assert_eq!(dir_mode & 0o777, 0o700, "log directory is not user-only");
        }

        std::fs::remove_dir_all(&dir).ok();
    }
}
