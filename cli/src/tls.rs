//! Process-wide TLS baseline.

/// Failure to establish the process-wide TLS baseline.
#[derive(Debug, thiserror::Error)]
pub enum TlsSetupError {
    /// A provider was already installed by another component.
    #[error("a rustls crypto provider was already installed")]
    AlreadyInstalled,
}

/// Install exactly one rustls crypto provider for the whole process.
///
/// Must be called as the first statement in `main`, before any TLS use. Both
/// `tokio-tungstenite` and the AWS SDK depend on rustls 0.23 without selecting a
/// provider; if two are enabled, rustls panics at first connect with an opaque
/// message instead of failing to compile.
///
/// Idempotent in effect: returns `Err` if a provider was already installed,
/// which callers may ignore, but must not be called from multiple threads.
pub fn install_crypto_provider() -> Result<(), TlsSetupError> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| TlsSetupError::AlreadyInstalled)
}

/// Temporary smoke check proving one TLS stack works end to end.
///
/// Folded into T4's config fetch once that lands; it exists so T1 has an
/// observable acceptance criterion for the crypto-provider risk. Any HTTP status
/// counts as success — reaching a status at all means the handshake completed.
pub async fn smoke_check(url: &str) -> anyhow::Result<u16> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let response = client.get(url).send().await?;
    Ok(response.status().as_u16())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crypto_provider_installs_once() {
        assert!(install_crypto_provider().is_ok());
        // Second install must be reported, not silently ignored: a duplicate
        // means some other component raced us to the process-wide slot.
        assert!(matches!(
            install_crypto_provider(),
            Err(TlsSetupError::AlreadyInstalled)
        ));
    }
}
