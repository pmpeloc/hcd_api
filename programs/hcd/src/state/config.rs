use anchor_lang::prelude::*;

/// Global program config. Seeds: ["config"]
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Program authority; the only signer allowed to verify providers.
    pub admin: Pubkey,
    /// Backend keypair allowed to call `log_access`. Different from the
    /// fee payer on purpose.
    pub key_service: Pubkey,
    /// Maximum lifetime of an AccessGrant, in seconds.
    pub max_grant_duration_secs: i64,
    pub bump: u8,
}
