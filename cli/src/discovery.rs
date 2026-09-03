//! Finding an agent to talk to, via AppSync.
//!
//! Entirely bypassable: `--runtime-id` with `--qualifier` short-circuits before
//! any network call, so a broken or unreachable AppSync endpoint can never stop
//! someone chatting with a runtime they already know the id of.
//!
//! Two constraints shape this module:
//!
//! 1. **The identity-pool credentials cannot list runtimes.** `ListAgentRuntimes`
//!    is not granted to the authenticated role, so discovery goes through
//!    AppSync's `listRuntimeAgents` — the same query the web UI's agent picker
//!    uses — with the raw Cognito ID token. There is no control-plane call here
//!    and adding one would fail with an access denial at runtime, not at compile
//!    time.
//! 2. **`qualifierToVersion` is a JSON string, not an object.** It is
//!    double-encoded in the GraphQL response (`json.dumps` inside the resolver in
//!    `src/api/functions/agent-factory-resolver/index.py`), so the endpoint list
//!    and the runtime version both come out of a second, inner parse.
//!
//! That inner map is also the answer to the `runtimeVersion: ""` that T10 sent:
//! the container writes the version onto the DynamoDB session row, so without it
//! the web UI's session list shows a blank endpoint for anything the CLI said.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::Deserialize;

use crate::telemetry::Secret;

/// Ceiling on the AppSync POST.
///
/// Shorter than the exports fetch: by this point the user is waiting between a
/// password prompt and a chat window, and discovery is optional anyway —
/// `--runtime-id` exists precisely so a slow endpoint is never load-bearing.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// The one query this CLI sends.
///
/// Only `listRuntimeAgents`: `qualifierToVersion` already carries every endpoint
/// and its version, so `listAgentEndpoints` and `listAgentVersions` would be two
/// extra round-trips for data already in hand.
///
/// `numberOfVersion` and `agentRuntimeArnA2A` are deliberately not selected. The
/// A2A ARN is null for the orchestrator architectures and this client never uses
/// it; the runtime ARN it signs over is built locally by
/// [`crate::presign::runtime_arn`], because the summary type has no account id.
const LIST_RUNTIME_AGENTS: &str = "query ListRuntimeAgents { \
     listRuntimeAgents { \
     agentName \
     agentRuntimeId \
     qualifierToVersion \
     status \
     architectureType \
     } \
     }";

/// One deployed agent, as AppSync reports it.
///
/// Mirrors the `RuntimeSummary` GraphQL type in `src/api/schema/schema.graphql`.
/// Three of those fields are declared non-null there and `Option` here on
/// purpose: this is a client, and a summary row missing its status is worth
/// listing without one rather than failing the whole query.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSummary {
    pub agent_name: String,
    pub agent_runtime_id: String,
    /// JSON **string** mapping endpoint name → version, e.g. `{"DEFAULT":"3"}`.
    /// Double-encoded in the GraphQL response — see [`RuntimeSummary::qualifiers`].
    pub qualifier_to_version: Option<String>,
    pub status: Option<String>,
    /// Which of the four agent containers this is (`SINGLE`, `SWARM`, …).
    ///
    /// Shown in the picker because it determines whether the event set is the one
    /// [`crate::protocol`] was verified against: only the single-agent container
    /// has been checked end to end.
    pub architecture_type: Option<String>,
}

impl RuntimeSummary {
    /// Parse [`RuntimeSummary::qualifier_to_version`] into endpoint → version.
    ///
    /// Returns an empty map when absent or unparsable rather than erroring: a
    /// malformed summary should degrade to "ask the user", not "refuse to list
    /// anything". Mirrors the browser's `resolveRuntimeVersion`
    /// (`src/user-interface/react-app/src/common/utils.ts`), which also swallows
    /// a parse failure and yields `""`.
    ///
    /// Values are stringified rather than typed: the resolver writes them through
    /// `json.dumps(..., default=str)` over DynamoDB `Decimal`s, so a version
    /// arrives as `"3"` in practice but `3` is equally well-formed, and both must
    /// produce the same qualifier list.
    pub fn qualifiers(&self) -> BTreeMap<String, String> {
        let Some(raw) = &self.qualifier_to_version else {
            return BTreeMap::new();
        };
        let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(raw)
        else {
            tracing::warn!(
                agent = %self.agent_name,
                "ignoring unparsable qualifierToVersion"
            );
            return BTreeMap::new();
        };
        map.into_iter()
            .map(|(qualifier, version)| {
                let version = match version {
                    serde_json::Value::String(text) => text,
                    serde_json::Value::Null => String::new(),
                    other => other.to_string(),
                };
                (qualifier, version)
            })
            .collect()
    }

    /// A one-line label for the picker.
    fn label(&self) -> String {
        let architecture = self.architecture_type.as_deref().unwrap_or("unknown");
        let status = self.status.as_deref().unwrap_or("unknown status");
        let endpoints = self.qualifiers();
        let endpoints = if endpoints.is_empty() {
            "no endpoints".to_string()
        } else {
            endpoints.keys().cloned().collect::<Vec<_>>().join(", ")
        };
        format!(
            "{} [{architecture}, {status}] — {endpoints}",
            self.agent_name
        )
    }
}

/// A fully-resolved connection target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub agent_runtime_id: String,
    pub qualifier: String,
    /// The runtime version behind [`Target::qualifier`], or empty when unknown.
    ///
    /// Empty in the `--runtime-id` path, which by definition has no summary to
    /// read a version from. The container's session write uses `if_not_exists`,
    /// so an empty value is skipped rather than stored as a blank — the same
    /// thing the browser sends when it cannot resolve one.
    pub runtime_version: String,
}

/// Asks the user to choose from a list.
///
/// Behind a trait so that "a single-agent, single-endpoint deployment selects
/// silently" is an assertion about a recorded fake rather than a claim about
/// terminal behaviour nobody can test.
pub trait Chooser {
    /// Pick one of `options` by index. `subject` names what is being chosen.
    fn choose(&self, subject: &str, options: &[String]) -> Result<usize, DiscoveryError>;
}

/// Reads the choice from the terminal.
pub struct TerminalChooser;

impl Chooser for TerminalChooser {
    fn choose(&self, subject: &str, options: &[String]) -> Result<usize, DiscoveryError> {
        // stderr throughout: stdout is the chat transcript, and a menu in it
        // would corrupt a redirected run.
        eprintln!("Available {subject}:");
        for (index, option) in options.iter().enumerate() {
            eprintln!("  {}) {option}", index + 1);
        }

        let raw = crate::ui::plain::prompt_line(&format!("Choose a {subject} [1]: "))
            .map_err(|err| DiscoveryError::Unselectable(err.to_string()))?;
        if raw.is_empty() {
            // Enter takes the first entry, so the common case is one keypress.
            return Ok(0);
        }
        let chosen: usize = raw
            .parse()
            .map_err(|_| DiscoveryError::Unselectable(format!("`{raw}` is not a number")))?;
        chosen
            .checked_sub(1)
            .filter(|index| *index < options.len())
            .ok_or_else(|| {
                DiscoveryError::Unselectable(format!(
                    "{chosen} is not one of the {} options",
                    options.len()
                ))
            })
    }
}

/// The target the user named on the command line, if any.
///
/// Pure and network-free, so `main` can reject an unusable invocation *before*
/// prompting for a password: discovering after the password prompt that
/// `--qualifier` was missing wastes the one interaction the user cannot script.
///
/// Returns `Ok(None)` when no `--runtime-id` was given, meaning discovery is
/// needed.
pub fn explicit_target(args: &crate::args::ChatArgs) -> Result<Option<Target>, DiscoveryError> {
    match (&args.runtime_id, &args.qualifier) {
        (Some(runtime_id), Some(qualifier)) => Ok(Some(Target {
            agent_runtime_id: runtime_id.clone(),
            qualifier: qualifier.clone(),
            // No summary was fetched, so there is no version to resolve.
            runtime_version: String::new(),
        })),
        // Not a guess: there is no way to enumerate an agent's endpoints in this
        // path, and picking `DEFAULT` for the user would connect them to
        // something they did not ask for.
        (Some(_), None) => Err(DiscoveryError::QualifierRequired),
        (None, _) => Ok(None),
    }
}

/// Query `listRuntimeAgents`.
///
/// A plain HTTPS POST with the **raw ID token** in `Authorization` — no `Bearer`
/// prefix, no SigV4, no generated GraphQL client. The field is
/// `@aws_cognito_user_pools`, so the user's own login is the only authorisation
/// involved and no extra IAM is needed.
pub async fn list_runtime_agents(
    appsync_url: &str,
    id_token: &Secret<String>,
) -> Result<Vec<RuntimeSummary>, DiscoveryError> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|err| DiscoveryError::Http(err.to_string()))?;

    let response = client
        .post(appsync_url)
        // `expose` is the one way to read a Secret, which is what makes every
        // site that handles a token greppable. The header never reaches the log:
        // tracing below records the URL and a count, nothing else.
        .header(reqwest::header::AUTHORIZATION, id_token.expose())
        .json(&serde_json::json!({ "query": LIST_RUNTIME_AGENTS }))
        .send()
        .await
        .map_err(|err| DiscoveryError::Http(err.to_string()))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| DiscoveryError::Http(err.to_string()))?;

    // AppSync answers 401 with a body worth quoting ("Unauthorized") and 200
    // with a GraphQL `errors` array, so the status is checked before the parse
    // but is not the only thing checked.
    if !status.is_success() {
        return Err(DiscoveryError::Http(format!(
            "{appsync_url} returned {status}: {}",
            body.trim()
        )));
    }

    let envelope: GraphQlResponse<ListRuntimeAgents> = serde_json::from_str(&body)
        .map_err(|err| DiscoveryError::GraphQl(format!("unreadable response: {err}")))?;

    // Errors are reported even alongside partial data: a caller silently taking
    // the data half would hide an authorisation problem behind an empty list.
    if let Some(errors) = envelope.errors.filter(|errors| !errors.is_empty()) {
        let joined = errors
            .iter()
            .map(|error| error.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(DiscoveryError::GraphQl(joined));
    }

    let agents = envelope
        .data
        .and_then(|data| data.list_runtime_agents)
        .unwrap_or_default();
    tracing::info!(count = agents.len(), "listed runtime agents");
    Ok(agents)
}

/// Fetch the listing the target will be chosen from, or nothing when
/// `--runtime-id` has already named one.
///
/// Returns `Ok(None)` **before reading `appsync_url`** in the explicit-target
/// case, which is what makes the "`--runtime-id` reaches a connection with zero
/// AppSync calls" rule provable rather than assumed: with no endpoint
/// configured, any attempt to list would be [`DiscoveryError::NoEndpoint`], so
/// `Ok(None)` can only mean nothing was tried.
///
/// Takes the ID token **by value** rather than through a source trait, so this
/// can run concurrently with the identity-pool exchange that builds the
/// credential broker — the two need the same freshly-minted token and neither
/// feeds the other, so running them back to back cost a round trip for nothing.
pub async fn listing_for(
    config: &crate::config::AppConfig,
    args: &crate::args::ChatArgs,
    id_token: &Secret<String>,
) -> Result<Option<Vec<RuntimeSummary>>, DiscoveryError> {
    if explicit_target(args)?.is_some() {
        return Ok(None);
    }

    let appsync_url = config
        .appsync_url
        .as_deref()
        .ok_or(DiscoveryError::NoEndpoint)?;
    list_runtime_agents(appsync_url, id_token).await.map(Some)
}

/// Choose an agent and qualifier from a fetched listing.
///
/// Split from [`resolve_target`] so the selection rules — which are the part with
/// behaviour worth pinning — are testable without a network call.
pub fn select_target(
    agents: &[RuntimeSummary],
    preferred_qualifier: Option<&str>,
    chooser: &dyn Chooser,
) -> Result<Target, DiscoveryError> {
    if agents.is_empty() {
        return Err(DiscoveryError::NoAgents);
    }

    let agent = if agents.len() == 1 {
        &agents[0]
    } else {
        let labels: Vec<String> = agents.iter().map(RuntimeSummary::label).collect();
        let chosen = chooser.choose("agent", &labels)?;
        agents
            .get(chosen)
            .ok_or_else(|| DiscoveryError::Unselectable(format!("no agent at index {chosen}")))?
    };

    let qualifiers = agent.qualifiers();
    if qualifiers.is_empty() {
        return Err(DiscoveryError::NoQualifiers(agent.agent_name.clone()));
    }

    let (qualifier, version) = match preferred_qualifier {
        // An explicit `--qualifier` is honoured, but only if the agent actually
        // has it: connecting to a qualifier that does not exist fails at the
        // handshake with an opaque 400.
        Some(wanted) => {
            let version =
                qualifiers
                    .get(wanted)
                    .ok_or_else(|| DiscoveryError::UnknownQualifier {
                        agent: agent.agent_name.clone(),
                        qualifier: wanted.to_string(),
                        available: qualifiers.keys().cloned().collect::<Vec<_>>().join(", "),
                    })?;
            (wanted.to_string(), version.clone())
        }
        None if qualifiers.len() == 1 => {
            let (qualifier, version) = qualifiers
                .iter()
                .next()
                .expect("checked non-empty and length 1");
            (qualifier.clone(), version.clone())
        }
        None => {
            let labels: Vec<String> = qualifiers
                .iter()
                .map(|(qualifier, version)| format!("{qualifier} (version {version})"))
                .collect();
            let chosen = chooser.choose("endpoint", &labels)?;
            let (qualifier, version) = qualifiers.iter().nth(chosen).ok_or_else(|| {
                DiscoveryError::Unselectable(format!("no endpoint at index {chosen}"))
            })?;
            (qualifier.clone(), version.clone())
        }
    };

    tracing::info!(
        agent = %agent.agent_name,
        agent_runtime_id = %agent.agent_runtime_id,
        qualifier = %qualifier,
        runtime_version = %version,
        "resolved target"
    );
    Ok(Target {
        agent_runtime_id: agent.agent_runtime_id.clone(),
        qualifier,
        runtime_version: version,
    })
}

/// One selectable row for an in-chat picker: a label and the target it means.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selectable {
    pub label: String,
    pub target: Target,
}

/// Flatten a listing into one row per (agent, endpoint) pair.
///
/// The two-step prompt [`select_target`] uses suits a command line, where each
/// question can be answered before the next is asked. A picker inside a running
/// chat has one list and one keypress, so agent and endpoint are pre-combined
/// here — which also means an agent with two endpoints is visibly two choices
/// rather than a choice that silently asks a second question.
///
/// Agents with no endpoints are omitted: there is nothing to connect to, and
/// offering the row would only produce a handshake failure.
pub fn selectable_targets(agents: &[RuntimeSummary]) -> Vec<Selectable> {
    let mut rows = Vec::new();
    for agent in agents {
        for (qualifier, version) in agent.qualifiers() {
            let architecture = agent.architecture_type.as_deref().unwrap_or("unknown");
            let status = agent.status.as_deref().unwrap_or("unknown status");
            let shown_version = if version.is_empty() {
                "version unknown".to_string()
            } else {
                format!("v{version}")
            };
            rows.push(Selectable {
                label: format!(
                    "{} / {qualifier}  [{shown_version}, {architecture}, {status}]",
                    agent.agent_name
                ),
                target: Target {
                    agent_runtime_id: agent.agent_runtime_id.clone(),
                    qualifier,
                    runtime_version: version,
                },
            });
        }
    }
    rows
}

/// Render the listing for `aca agents`.
///
/// Returns the text rather than printing it, so the format is assertable.
pub fn render_listing(agents: &[RuntimeSummary]) -> String {
    if agents.is_empty() {
        return "no agents are deployed in this account\n".to_string();
    }

    let mut out = String::new();
    for agent in agents {
        let qualifiers = agent.qualifiers();
        out.push_str(&format!(
            "{}\n  runtime id:   {}\n  architecture: {}\n  status:       {}\n",
            agent.agent_name,
            agent.agent_runtime_id,
            agent.architecture_type.as_deref().unwrap_or("unknown"),
            agent.status.as_deref().unwrap_or("unknown"),
        ));
        if qualifiers.is_empty() {
            out.push_str("  endpoints:    none\n");
        } else {
            for (qualifier, version) in &qualifiers {
                out.push_str(&format!(
                    "  endpoint:     {qualifier} (version {version})\n"
                ));
            }
        }
        out.push('\n');
    }
    out
}

/// Why an agent could not be resolved.
#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error(
        "no AppSync endpoint is configured; pass --runtime-id and --qualifier to connect directly"
    )]
    NoEndpoint,
    #[error(
        "--qualifier is required with --runtime-id: there is no way to list an agent's endpoints without discovery, and guessing DEFAULT could connect you to the wrong one"
    )]
    QualifierRequired,
    #[error("AppSync request failed: {0}")]
    Http(String),
    #[error("AppSync returned errors: {0}")]
    GraphQl(String),
    #[error("no agents are deployed in this account")]
    NoAgents,
    #[error("agent `{0}` has no endpoints; deploy an endpoint for it first")]
    NoQualifiers(String),
    #[error("agent `{agent}` has no endpoint `{qualifier}`; it has: {available}")]
    UnknownQualifier {
        agent: String,
        qualifier: String,
        available: String,
    },
    #[error("could not obtain an ID token for discovery: {0}")]
    Credentials(String),
    #[error("could not read a selection: {0}")]
    Unselectable(String),
}

/// The GraphQL envelope. `data` and `errors` can both be present.
#[derive(Debug, Deserialize)]
struct GraphQlResponse<T> {
    data: Option<T>,
    errors: Option<Vec<GraphQlError>>,
}

#[derive(Debug, Deserialize)]
struct GraphQlError {
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRuntimeAgents {
    /// Nullable in the schema (`[RuntimeSummary!]`), and the resolver returns
    /// `[]` on a DynamoDB failure — so an empty list is a plausible success, not
    /// necessarily an error.
    list_runtime_agents: Option<Vec<RuntimeSummary>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Records what it was asked, and answers with a fixed index.
    struct FakeChooser {
        answer: usize,
        asked: RefCell<Vec<(String, Vec<String>)>>,
    }

    impl FakeChooser {
        fn answering(answer: usize) -> Self {
            Self {
                answer,
                asked: RefCell::new(Vec::new()),
            }
        }

        fn subjects(&self) -> Vec<String> {
            self.asked
                .borrow()
                .iter()
                .map(|(subject, _)| subject.clone())
                .collect()
        }
    }

    impl Chooser for FakeChooser {
        fn choose(&self, subject: &str, options: &[String]) -> Result<usize, DiscoveryError> {
            self.asked
                .borrow_mut()
                .push((subject.to_string(), options.to_vec()));
            Ok(self.answer)
        }
    }

    /// Panics if consulted — the way "selects silently" is asserted.
    struct NeverChooser;

    impl Chooser for NeverChooser {
        fn choose(&self, subject: &str, options: &[String]) -> Result<usize, DiscoveryError> {
            panic!("must not prompt: asked for {subject} among {options:?}");
        }
    }

    fn agent(name: &str, qualifier_to_version: Option<&str>) -> RuntimeSummary {
        RuntimeSummary {
            agent_name: name.to_string(),
            agent_runtime_id: format!("{name}-AbCdEf1234"),
            qualifier_to_version: qualifier_to_version.map(str::to_string),
            status: Some("Ready".to_string()),
            architecture_type: Some("SINGLE".to_string()),
        }
    }

    /// The shape the resolver actually produces: `qualifierToVersion` is a JSON
    /// **string** nested inside the JSON response, which is the single most
    /// likely thing for a reader to "fix" into an object.
    #[test]
    fn a_realistic_response_parses_including_the_double_encoded_map() {
        let body = r#"{
            "data": {
                "listRuntimeAgents": [
                    {
                        "agentName": "weather_agent",
                        "agentRuntimeId": "weather_agent-AbCdEf1234",
                        "qualifierToVersion": "{\"DEFAULT\": \"3\", \"staging\": \"2\"}",
                        "status": "Ready",
                        "architectureType": "SINGLE"
                    },
                    {
                        "agentName": "research_swarm",
                        "agentRuntimeId": "research_swarm-Zz9988",
                        "qualifierToVersion": "{\"DEFAULT\": \"1\"}",
                        "status": "Updating",
                        "architectureType": "SWARM"
                    }
                ]
            }
        }"#;

        let envelope: GraphQlResponse<ListRuntimeAgents> =
            serde_json::from_str(body).expect("parse");
        let agents = envelope
            .data
            .and_then(|data| data.list_runtime_agents)
            .expect("data");

        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].agent_name, "weather_agent");
        assert_eq!(
            agents[0].qualifiers(),
            BTreeMap::from([
                ("DEFAULT".to_string(), "3".to_string()),
                ("staging".to_string(), "2".to_string()),
            ])
        );
        assert_eq!(agents[1].architecture_type.as_deref(), Some("SWARM"));
    }

    #[test]
    fn numeric_versions_parse_the_same_as_string_ones() {
        // `json.dumps(..., default=str)` over a DynamoDB Decimal yields "3", but
        // a plain int is equally well-formed JSON and must not read as absent.
        let numeric = agent("a", Some(r#"{"DEFAULT": 3}"#));
        assert_eq!(
            numeric.qualifiers(),
            BTreeMap::from([("DEFAULT".to_string(), "3".to_string())])
        );
    }

    #[test]
    fn a_malformed_qualifier_map_yields_an_empty_map_not_an_error() {
        // Mirrors the browser, which swallows the parse failure. Degrading to
        // "this agent has no endpoints" keeps the rest of the listing usable.
        for broken in [
            r#"not json"#,
            r#""#,
            r#"[]"#,
            r#"null"#,
            r#"{"unterminated": "#,
            r#""a string, not an object""#,
        ] {
            let summary = agent("a", Some(broken));
            assert!(
                summary.qualifiers().is_empty(),
                "{broken:?} should yield an empty map"
            );
        }
        assert!(agent("a", None).qualifiers().is_empty());
    }

    #[test]
    fn graphql_errors_are_reported_even_with_partial_data() {
        let body = r#"{
            "data": {"listRuntimeAgents": null},
            "errors": [{"message": "Not Authorized to access listRuntimeAgents on type Query"}]
        }"#;
        let envelope: GraphQlResponse<ListRuntimeAgents> =
            serde_json::from_str(body).expect("parse");
        let errors = envelope.errors.expect("errors");
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("Not Authorized"));
    }

    #[test]
    fn an_explicit_runtime_id_and_qualifier_need_no_network() {
        let args = crate::args::ChatArgs {
            runtime_id: Some("weather_agent-AbCdEf1234".into()),
            qualifier: Some("DEFAULT".into()),
            ..Default::default()
        };
        assert_eq!(
            explicit_target(&args).expect("valid"),
            Some(Target {
                agent_runtime_id: "weather_agent-AbCdEf1234".into(),
                qualifier: "DEFAULT".into(),
                // Unknown in this path: no summary was fetched.
                runtime_version: String::new(),
            })
        );
    }

    #[test]
    fn a_runtime_id_without_a_qualifier_is_an_error_not_a_guess() {
        let args = crate::args::ChatArgs {
            runtime_id: Some("weather_agent-AbCdEf1234".into()),
            ..Default::default()
        };
        let err = explicit_target(&args).expect_err("must be rejected");
        assert!(matches!(err, DiscoveryError::QualifierRequired));
        // The message has to say what to do, since there is no way to enumerate
        // endpoints from here.
        let rendered = err.to_string();
        assert!(rendered.contains("--qualifier"), "{rendered}");
    }

    #[test]
    fn no_runtime_id_means_discovery_is_needed() {
        assert_eq!(
            explicit_target(&crate::args::ChatArgs::default()).expect("valid"),
            None
        );
    }

    fn config_with_endpoint(appsync_url: Option<&str>) -> crate::config::AppConfig {
        crate::config::AppConfig {
            region: "us-west-2".into(),
            account_id: "123456789012".into(),
            user_pool_id: "us-west-2_Pool".into(),
            user_pool_client_id: "client".into(),
            identity_pool_id: "us-west-2:identity".into(),
            appsync_url: appsync_url.map(str::to_string),
        }
    }

    /// The acceptance check, proved rather than assumed: **no endpoint is
    /// configured at all**, so anything that tried to list would return
    /// `NoEndpoint`. Getting `Ok(None)` is only possible if nothing was tried.
    ///
    /// Pointing at an unreachable host would *not* prove this — that passes
    /// whether or not a call was attempted.
    #[tokio::test]
    async fn an_explicit_target_needs_no_listing_and_no_endpoint() {
        let args = crate::args::ChatArgs {
            runtime_id: Some("weather_agent-AbCdEf1234".into()),
            qualifier: Some("DEFAULT".into()),
            ..Default::default()
        };

        let listing = listing_for(
            &config_with_endpoint(None),
            &args,
            &Secret::new("unused".to_string()),
        )
        .await
        .expect("an explicit target must need no listing");
        assert!(listing.is_none(), "nothing may be fetched");

        // And the target itself still resolves, from the flags alone.
        let target = explicit_target(&args)
            .expect("valid flags")
            .expect("a target");
        assert_eq!(target.agent_runtime_id, "weather_agent-AbCdEf1234");
        assert_eq!(target.qualifier, "DEFAULT");
    }

    #[tokio::test]
    async fn discovery_without_an_endpoint_names_the_way_out() {
        // No `--runtime-id`, so a listing is required — and impossible.
        let err = listing_for(
            &config_with_endpoint(None),
            &crate::args::ChatArgs::default(),
            &Secret::new("unused".to_string()),
        )
        .await
        .expect_err("must fail");

        assert!(matches!(err, DiscoveryError::NoEndpoint));
        let rendered = err.to_string();
        assert!(rendered.contains("--runtime-id"), "{rendered}");
    }

    #[test]
    fn one_agent_with_one_endpoint_is_chosen_silently() {
        // The acceptance check: the common single-agent deployment must not make
        // the user answer two menus with one entry each.
        let agents = vec![agent("weather_agent", Some(r#"{"DEFAULT": "3"}"#))];
        let target = select_target(&agents, None, &NeverChooser).expect("silent selection");
        assert_eq!(
            target,
            Target {
                agent_runtime_id: "weather_agent-AbCdEf1234".into(),
                qualifier: "DEFAULT".into(),
                // The whole point of discovery over `--runtime-id`: the version
                // is resolved, so the session row is not written blank.
                runtime_version: "3".into(),
            }
        );
    }

    #[test]
    fn several_agents_prompt_once_and_a_single_endpoint_still_does_not() {
        let agents = vec![
            agent("weather_agent", Some(r#"{"DEFAULT": "3"}"#)),
            agent("research_swarm", Some(r#"{"DEFAULT": "1"}"#)),
        ];
        let chooser = FakeChooser::answering(1);
        let target = select_target(&agents, None, &chooser).expect("selection");

        assert_eq!(target.agent_runtime_id, "research_swarm-AbCdEf1234");
        assert_eq!(target.runtime_version, "1");
        // Exactly one prompt: the agent. The endpoint was unambiguous.
        assert_eq!(chooser.subjects(), vec!["agent".to_string()]);
    }

    #[test]
    fn several_endpoints_prompt_for_the_endpoint_too() {
        let agents = vec![agent(
            "weather_agent",
            Some(r#"{"DEFAULT": "3", "staging": "2"}"#),
        )];
        let chooser = FakeChooser::answering(1);
        let target = select_target(&agents, None, &chooser).expect("selection");

        // BTreeMap order: DEFAULT, staging — so index 1 is staging.
        assert_eq!(target.qualifier, "staging");
        assert_eq!(target.runtime_version, "2");
        assert_eq!(chooser.subjects(), vec!["endpoint".to_string()]);
    }

    #[test]
    fn an_explicit_qualifier_skips_the_endpoint_prompt_and_resolves_its_version() {
        let agents = vec![agent(
            "weather_agent",
            Some(r#"{"DEFAULT": "3", "staging": "2"}"#),
        )];
        let target = select_target(&agents, Some("staging"), &NeverChooser).expect("selection");
        assert_eq!(target.qualifier, "staging");
        assert_eq!(target.runtime_version, "2");
    }

    #[test]
    fn an_explicit_qualifier_the_agent_lacks_is_rejected_with_the_alternatives() {
        // Left to the handshake this is an opaque 400, so it is caught here where
        // the available names are in hand.
        let agents = vec![agent("weather_agent", Some(r#"{"DEFAULT": "3"}"#))];
        let err = select_target(&agents, Some("prod"), &NeverChooser).expect_err("must fail");
        let rendered = err.to_string();
        assert!(rendered.contains("prod"), "{rendered}");
        assert!(rendered.contains("DEFAULT"), "{rendered}");
    }

    #[test]
    fn an_empty_listing_and_an_endpointless_agent_are_distinct_errors() {
        let err = select_target(&[], None, &NeverChooser).expect_err("must fail");
        assert!(matches!(err, DiscoveryError::NoAgents));

        let agents = vec![agent("weather_agent", None)];
        let err = select_target(&agents, None, &NeverChooser).expect_err("must fail");
        let DiscoveryError::NoQualifiers(name) = err else {
            panic!("wrong error: {err:?}");
        };
        assert_eq!(name, "weather_agent");
    }

    #[test]
    fn the_agent_label_carries_what_a_choice_needs() {
        let label = agent("weather_agent", Some(r#"{"DEFAULT": "3", "staging": "2"}"#)).label();
        assert!(label.contains("weather_agent"), "{label}");
        // Architecture is in the label because only the single-agent container
        // has a verified event set.
        assert!(label.contains("SINGLE"), "{label}");
        assert!(label.contains("Ready"), "{label}");
        assert!(label.contains("DEFAULT"), "{label}");
        assert!(label.contains("staging"), "{label}");
    }

    #[test]
    fn a_summary_missing_its_optional_fields_still_lists() {
        let summary = RuntimeSummary {
            agent_name: "bare".to_string(),
            agent_runtime_id: "bare-1".to_string(),
            qualifier_to_version: None,
            status: None,
            architecture_type: None,
        };
        let label = summary.label();
        assert!(label.contains("unknown"), "{label}");
        assert!(label.contains("no endpoints"), "{label}");
    }

    #[test]
    fn the_listing_names_every_agent_and_endpoint() {
        let agents = vec![
            agent("weather_agent", Some(r#"{"DEFAULT": "3", "staging": "2"}"#)),
            agent("bare_agent", None),
        ];
        let rendered = render_listing(&agents);
        for expected in [
            "weather_agent",
            "weather_agent-AbCdEf1234",
            "DEFAULT (version 3)",
            "staging (version 2)",
            "SINGLE",
            "Ready",
            "bare_agent",
            "endpoints:    none",
        ] {
            assert!(rendered.contains(expected), "{rendered} omits {expected}");
        }
    }

    #[test]
    fn the_picker_offers_one_row_per_endpoint_with_its_version_resolved() {
        let agents = vec![
            agent("weather_agent", Some(r#"{"DEFAULT": "3", "staging": "2"}"#)),
            agent("research_swarm", Some(r#"{"DEFAULT": "1"}"#)),
        ];
        let rows = selectable_targets(&agents);

        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[0].target,
            Target {
                agent_runtime_id: "weather_agent-AbCdEf1234".into(),
                qualifier: "DEFAULT".into(),
                // Resolved, not blank: switching agents from inside a chat must
                // not write a session row with an empty version.
                runtime_version: "3".into(),
            }
        );
        assert!(rows[1].label.contains("staging"), "{}", rows[1].label);
        assert!(rows[1].label.contains("v2"), "{}", rows[1].label);
        assert!(
            rows[2].label.contains("research_swarm"),
            "{}",
            rows[2].label
        );
    }

    #[test]
    fn the_picker_omits_agents_with_nothing_to_connect_to() {
        // An endpointless agent is not a choice; offering it would produce a
        // handshake failure the user cannot act on.
        let agents = vec![
            agent("bare_agent", None),
            agent("weather_agent", Some(r#"{"DEFAULT": "1"}"#)),
        ];
        let rows = selectable_targets(&agents);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].label.contains("weather_agent"));
        assert!(selectable_targets(&[]).is_empty());
    }

    #[test]
    fn an_empty_listing_says_so_rather_than_printing_nothing() {
        assert!(render_listing(&[]).contains("no agents"));
    }

    /// The query text is what the endpoint validates, so a typo is a runtime
    /// GraphQL error rather than a compile failure.
    #[test]
    fn the_query_selects_exactly_the_fields_the_summary_deserialises() {
        for field in [
            "listRuntimeAgents",
            "agentName",
            "agentRuntimeId",
            "qualifierToVersion",
            "status",
            "architectureType",
        ] {
            assert!(
                LIST_RUNTIME_AGENTS.contains(field),
                "query omits {field}: {LIST_RUNTIME_AGENTS}"
            );
        }
        // Not selected on purpose — see the const's doc comment.
        assert!(!LIST_RUNTIME_AGENTS.contains("agentRuntimeArnA2A"));
        assert!(!LIST_RUNTIME_AGENTS.contains("numberOfVersion"));
    }
}
