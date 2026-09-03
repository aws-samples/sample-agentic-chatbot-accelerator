//! User-facing argument surface.
//!
//! This module is the settled input contract for every later task: it declares
//! *what* can be asked for, never *how* it is honoured. Two rules shape it:
//!
//! - Backend identity is discovered from the deployment's public
//!   `aws-exports.json`, so the common case is one flag, not six. Each field it
//!   supplies stays individually overridable for split or hand-rolled stacks.
//! - No presigned URL is ever accepted as an argument. It is a bearer
//!   credential with the same power as the session itself, and an argument would
//!   persist it in shell history and process listings (design doc §5).

use clap::{Args, Parser, Subcommand};

/// Top-level CLI. `chat` is the default when no subcommand is given.
#[derive(Parser, Debug)]
#[command(name = "aca", version, about = "Chat with a deployed AgentCore agent")]
pub struct Cli {
    /// Absent means `chat`: the overwhelmingly common invocation is a bare
    /// `aca`, and `Option<Command>` keeps `aca --help` readable where clap's
    /// `default_subcommand` machinery would bury the flattened config flags.
    #[command(subcommand)]
    pub command: Option<Command>,

    /// Backend identity flags, accepted at the top level so they apply to every
    /// subcommand without being repeated per-variant.
    #[command(flatten)]
    pub config: ConfigArgs,
}

/// What the invocation is asking the CLI to do.
#[derive(Subcommand, Debug)]
pub enum Command {
    /// Interactive chat session (default).
    Chat(ChatArgs),
    /// List deployed agents with their endpoints, and exit.
    Agents(AgentsArgs),
    /// Forget the saved session, so the next run asks for a password.
    Logout,
}

/// Inputs for `aca agents`.
///
/// Carries its own credential flags rather than sharing [`ChatArgs`]: listing
/// still needs a Cognito login (the AppSync field is
/// `@aws_cognito_user_pools`), but none of the chat-shaped options —
/// `--session-id`, `--plain`, `--message` — mean anything for it, and offering
/// them would imply they did.
#[derive(Args, Debug, Default)]
pub struct AgentsArgs {
    /// Cognito user's email. Prompted interactively when absent.
    #[arg(long, env = "ACA_EMAIL")]
    pub email: Option<String>,

    /// Read the password from stdin instead of prompting (for scripted use).
    #[arg(long)]
    pub password_stdin: bool,
}

/// Backend identity discovery. `--aws-exports-url` is the primary bootstrap;
/// every field it provides can be overridden individually.
///
/// Every field carries an `ACA_`-prefixed environment fallback so a customer
/// working against one deployment can export them once instead of passing the
/// same flags on every invocation.
#[derive(Args, Debug, Default)]
pub struct ConfigArgs {
    /// URL of the deployment's public `aws-exports.json`, e.g.
    /// `https://d111.cloudfront.net/aws-exports.json`. Needs no AWS credentials.
    #[arg(long, env = "ACA_AWS_EXPORTS_URL")]
    pub aws_exports_url: Option<String>,

    /// AWS region hosting the deployment.
    #[arg(long, env = "ACA_REGION")]
    pub region: Option<String>,
    /// AWS account id hosting the deployment.
    #[arg(long, env = "ACA_ACCOUNT_ID")]
    pub account_id: Option<String>,
    /// Cognito user pool id used to authenticate the operator.
    #[arg(long, env = "ACA_USER_POOL_ID")]
    pub user_pool_id: Option<String>,
    /// Cognito user pool *app client* id used for `USER_PASSWORD_AUTH`.
    #[arg(long, env = "ACA_USER_POOL_CLIENT_ID")]
    pub user_pool_client_id: Option<String>,
    /// Cognito identity pool id exchanged for the SigV4 credentials.
    #[arg(long, env = "ACA_IDENTITY_POOL_ID")]
    pub identity_pool_id: Option<String>,
    /// AppSync GraphQL endpoint, used only to list agents.
    #[arg(long, env = "ACA_APPSYNC_URL")]
    pub appsync_url: Option<String>,

    /// Skip reading and writing the on-disk config cache.
    #[arg(long)]
    pub no_cache: bool,

    /// Ignore any saved session and authenticate from scratch.
    ///
    /// The session that results **is** saved, replacing the one that was ignored:
    /// this means "do not reuse what is stored", not "do not store anything".
    /// Skipping the write too would leave a stale file for the next run to trip
    /// over. Use `aca logout` to leave nothing on disk.
    ///
    /// Separate from `--no-cache`, which is about the *non-secret* config file:
    /// these are two different files with two different risk profiles, and one
    /// flag covering both would make "don't reuse my credentials" impossible to
    /// ask for without also re-fetching the deployment's ids.
    #[arg(long)]
    pub fresh_login: bool,
}

/// Inputs specific to a chat session.
#[derive(Args, Debug, Default)]
pub struct ChatArgs {
    /// Cognito user's email. Prompted interactively when absent.
    #[arg(long, env = "ACA_EMAIL")]
    pub email: Option<String>,

    /// Read the password from stdin instead of prompting (for scripted use).
    /// Mutually exclusive with an interactive prompt.
    ///
    /// There is deliberately no `--password`: an argument would leave the
    /// secret in shell history and in every process listing.
    #[arg(long)]
    pub password_stdin: bool,

    /// Target runtime id. When given, skips AppSync discovery entirely, so a
    /// discovery failure can never block chatting.
    #[arg(long)]
    pub runtime_id: Option<String>,

    /// Endpoint qualifier (e.g. `DEFAULT`). Defaults to the agent's only
    /// qualifier when discovery runs, otherwise required with `--runtime-id`.
    #[arg(long)]
    pub qualifier: Option<String>,

    /// Reuse an existing session id. Must be >= 33 characters (T5 validates).
    #[arg(long)]
    pub session_id: Option<String>,

    /// Force line-mode output. Implied automatically when stdout is not a TTY.
    #[arg(long)]
    pub plain: bool,

    /// Send one prompt, print the reply, exit. Implies `--plain`.
    ///
    /// Exists so the CLI is scriptable and so its output survives redirection —
    /// a one-shot has no interactive loop to drive a full-screen UI.
    #[arg(long, short = 'm')]
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `ConfigArgs` env var, paired for set/remove in one place.
    const CONFIG_ENV: &[(&str, &str)] = &[
        (
            "ACA_AWS_EXPORTS_URL",
            "https://env.example/aws-exports.json",
        ),
        ("ACA_REGION", "eu-west-1"),
        ("ACA_ACCOUNT_ID", "111122223333"),
        ("ACA_USER_POOL_ID", "eu-west-1_envpool"),
        ("ACA_USER_POOL_CLIENT_ID", "envclient"),
        ("ACA_IDENTITY_POOL_ID", "eu-west-1:env-identity"),
        ("ACA_APPSYNC_URL", "https://env.example/graphql"),
    ];

    /// Env fallback and flag precedence share one test on purpose: mutating the
    /// process environment is global, so splitting them would let the two race
    /// under the test harness's thread pool. All `ConfigArgs` assertions live
    /// here for the same reason — no other test may read those vars.
    #[test]
    fn env_populates_config_and_flags_win() {
        // SAFETY: single-threaded within this test, and no other test in this
        // binary reads `ACA_*`, so nothing can observe a torn environment.
        unsafe {
            for (key, value) in CONFIG_ENV {
                std::env::set_var(key, value);
            }
        }

        let from_env = Cli::try_parse_from(["aca"]).expect("env-only parse");
        assert_eq!(
            from_env.config.aws_exports_url.as_deref(),
            Some("https://env.example/aws-exports.json")
        );
        assert_eq!(from_env.config.region.as_deref(), Some("eu-west-1"));
        assert_eq!(from_env.config.account_id.as_deref(), Some("111122223333"));
        assert_eq!(
            from_env.config.user_pool_id.as_deref(),
            Some("eu-west-1_envpool")
        );
        assert_eq!(
            from_env.config.user_pool_client_id.as_deref(),
            Some("envclient")
        );
        assert_eq!(
            from_env.config.identity_pool_id.as_deref(),
            Some("eu-west-1:env-identity")
        );
        assert_eq!(
            from_env.config.appsync_url.as_deref(),
            Some("https://env.example/graphql")
        );

        let overridden = Cli::try_parse_from([
            "aca",
            "--region",
            "us-east-1",
            "--user-pool-id",
            "us-east-1_flagpool",
        ])
        .expect("flag override parse");
        assert_eq!(overridden.config.region.as_deref(), Some("us-east-1"));
        assert_eq!(
            overridden.config.user_pool_id.as_deref(),
            Some("us-east-1_flagpool")
        );
        // Unmentioned fields still fall back, i.e. a flag overrides one value
        // rather than switching the whole env source off.
        assert_eq!(
            overridden.config.account_id.as_deref(),
            Some("111122223333")
        );

        unsafe {
            for (key, _) in CONFIG_ENV {
                std::env::remove_var(key);
            }
        }
    }

    #[test]
    fn no_args_is_chat() {
        let cli = Cli::try_parse_from(["aca"]).expect("bare invocation must parse");
        match cli.command.unwrap_or(Command::Chat(ChatArgs::default())) {
            Command::Chat(_) => {}
            other => panic!("expected the chat default, got {other:?}"),
        }
    }

    #[test]
    fn chat_flags_parse() {
        let cli = Cli::try_parse_from([
            "aca",
            "chat",
            "--runtime-id",
            "agent-abc",
            "--qualifier",
            "DEFAULT",
            "--session-id",
            "0123456789abcdef0123456789abcdef0",
            "--plain",
            "--password-stdin",
            "-m",
            "hi",
        ])
        .expect("chat flags must parse");

        let Some(Command::Chat(chat)) = cli.command else {
            panic!("expected the chat subcommand");
        };
        assert_eq!(chat.runtime_id.as_deref(), Some("agent-abc"));
        assert_eq!(chat.qualifier.as_deref(), Some("DEFAULT"));
        assert_eq!(
            chat.session_id.as_deref(),
            Some("0123456789abcdef0123456789abcdef0")
        );
        assert!(chat.plain);
        assert!(chat.password_stdin);
        assert_eq!(chat.message.as_deref(), Some("hi"));
    }

    #[test]
    fn agents_subcommand_parses_with_its_own_credential_flags() {
        let cli = Cli::try_parse_from(["aca", "agents"]).expect("agents must parse");
        assert!(matches!(cli.command, Some(Command::Agents(_))));

        let cli = Cli::try_parse_from(["aca", "agents", "--email", "a@example.com"])
            .expect("agents --email must parse");
        let Some(Command::Agents(args)) = cli.command else {
            panic!("wrong command");
        };
        assert_eq!(args.email.as_deref(), Some("a@example.com"));

        // Chat-shaped options are deliberately not offered here.
        assert!(Cli::try_parse_from(["aca", "agents", "--message", "hi"]).is_err());
    }

    /// clap's own consistency checks (duplicate flags, bad `short`/`long`
    /// combinations) only fire at runtime, so assert them once here.
    #[test]
    fn command_definition_is_valid() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }
}
