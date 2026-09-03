//! Opening — and re-opening — runtime sessions.
//!
//! Everything a second session needs (config, the credential broker, the
//! identity) is owned here rather than consumed once in `main`, because
//! `/session` and `/agent` both mean "connect again": a new AgentCore session id
//! is a new microVM, so re-signing and re-dialling is the *only* way to start a
//! fresh conversation. Before this module the sinks were handed a live socket and
//! had no way to obtain another one.
//!
//! The [`SessionControl`] trait exists for the same reason [`crate::discovery`]
//! has one: a [`SessionManager`] can only be built by talking to Cognito, so
//! without a trait the sinks' command handling would be untestable offline.

use std::pin::Pin;

use crate::auth::{CredentialBroker, Identity};
use crate::config::AppConfig;
use crate::discovery::{Chooser, DiscoveryError, RuntimeSummary, Target};
use crate::protocol::SessionId;
use crate::transport::{AgentConnection, ConnectParams, TransportError};

/// A boxed future, so [`SessionControl`] stays object-safe.
type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A live session: the socket plus what it was opened against.
///
/// The target travels with the connection so a sink can answer `/session`
/// ("the same agent, a new conversation") without having been told separately
/// what it is currently talking to.
pub struct Session {
    pub connection: AgentConnection,
    pub target: Target,
}

/// What a sink needs in order to start another session mid-chat.
///
/// Deliberately narrow: a sink can open a session and list what is available,
/// and can do nothing else with the credentials. Widening this to expose the
/// broker would put token handling inside the UI layer.
pub trait SessionControl: Send + 'static {
    /// Open a **fresh** session — a new session id, therefore a new container
    /// and an empty conversation — against `target`.
    fn open(&mut self, target: Target) -> BoxFuture<'_, Result<Session, SessionError>>;

    /// Open a session with a caller-chosen id.
    ///
    /// On the trait only so the TUI's startup connect can show the same
    /// connecting screen `/session` and `/agent` do — it is not exposed for
    /// sinks to call at will. `--session-id` resumes a named conversation, and
    /// that is only meaningful once, at the very first connect of a run; every
    /// later reconnect must go through [`SessionControl::open`] instead, which
    /// always picks a fresh random id. Nothing in the type system stops a sink
    /// from calling this mid-chat — the discipline is enforced by there being
    /// exactly one call site outside this module.
    fn open_with(
        &mut self,
        target: Target,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Session, SessionError>>;

    /// List the deployed agents, for a picker.
    fn agents(&mut self) -> BoxFuture<'_, Result<Vec<RuntimeSummary>, SessionError>>;
}

/// Owns the long-lived halves of a run: config, credentials, identity.
pub struct SessionManager {
    config: AppConfig,
    broker: CredentialBroker,
    identity: Identity,
}

impl SessionManager {
    pub fn new(config: AppConfig, broker: CredentialBroker, identity: Identity) -> Self {
        Self {
            config,
            broker,
            identity,
        }
    }

    /// Open a session with a caller-chosen session id.
    ///
    /// Separate from [`SessionControl::open`] so `--session-id` can resume a
    /// named conversation, while every *mid-chat* reconnect is forced through the
    /// random-id path and cannot accidentally reuse an id that is still draining.
    /// Also reachable through the trait now, for the TUI's very first connect —
    /// see the trait method's doc for why that is still the only other caller.
    pub async fn open_with(
        &mut self,
        target: Target,
        session_id: SessionId,
    ) -> Result<Session, SessionError> {
        let connection = crate::transport::connect(
            ConnectParams {
                config: &self.config,
                agent_runtime_id: &target.agent_runtime_id,
                qualifier: &target.qualifier,
                runtime_version: &target.runtime_version,
                session_id: &session_id,
                identity: &self.identity,
            },
            &mut self.broker,
        )
        .await?;
        Ok(Session { connection, target })
    }

    /// Resolve the target from the command line, prompting through `chooser`.
    ///
    /// Delegates to [`crate::discovery::resolve_target`]; it lives here only so
    /// that `main` can hand config and the broker to this type once instead of
    /// keeping its own copies alive for the whole run.
    pub async fn resolve(
        &mut self,
        args: &crate::args::ChatArgs,
        chooser: &dyn Chooser,
    ) -> Result<Target, SessionError> {
        // `self.config` and `self.broker` are disjoint fields, so the immutable
        // borrow of one alongside the mutable borrow of the other is fine.
        crate::discovery::resolve_target(&self.config, args, &mut self.broker, chooser)
            .await
            .map_err(SessionError::Discovery)
    }
}

impl SessionControl for SessionManager {
    fn open(&mut self, target: Target) -> BoxFuture<'_, Result<Session, SessionError>> {
        Box::pin(async move {
            // A fresh id, always: reusing the current one would land on the 409
            // retry path against a container that is still shutting down, and the
            // point of `/session` is an empty conversation anyway.
            self.open_with(target, SessionId::new_random()).await
        })
    }

    fn open_with(
        &mut self,
        target: Target,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Session, SessionError>> {
        // Resolves to the inherent method above, not a recursive trait call:
        // method lookup always prefers an inherent method over a trait one for
        // the same receiver type, exactly as `open`'s body already relies on.
        Box::pin(async move { self.open_with(target, session_id).await })
    }

    fn agents(&mut self) -> BoxFuture<'_, Result<Vec<RuntimeSummary>, SessionError>> {
        Box::pin(async move {
            let appsync_url = self
                .config
                .appsync_url
                .as_deref()
                .ok_or(SessionError::Discovery(DiscoveryError::NoEndpoint))?;
            let id_token = self.broker.id_token().await?;
            crate::discovery::list_runtime_agents(appsync_url, &id_token)
                .await
                .map_err(SessionError::Discovery)
        })
    }
}

/// Why a session could not be opened.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error(transparent)]
    Discovery(#[from] DiscoveryError),
    #[error(transparent)]
    Credentials(#[from] crate::auth::CredentialError),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sinks render these to the user verbatim, so a variant that lost its
    /// inner message would leave "could not start a new session" with no reason.
    #[test]
    fn every_variant_carries_the_underlying_message() {
        let transport: SessionError =
            TransportError::Timeout(std::time::Duration::from_secs(60)).into();
        assert!(
            transport.to_string().contains("cold-starting"),
            "{transport}"
        );

        let discovery: SessionError = DiscoveryError::NoAgents.into();
        assert!(discovery.to_string().contains("no agents"), "{discovery}");
    }
}
