use anchor_lang::prelude::*;

/// Time-bound permission for a doctor to read one record.
/// Seeds: ["grant", record, doctor]
#[account]
#[derive(InitSpace)]
pub struct AccessGrant {
    pub patient: Pubkey,
    pub doctor: Pubkey,
    pub record: Pubkey,
    /// Unix timestamp; checked against Clock, never against client input.
    pub expires_at: i64,
    pub status: GrantStatus,
    /// Source of truth for the audit trail; only `log_access` increments it.
    pub access_count: u64,
    /// Account that paid the rent; receives it back if the account is closed.
    pub rent_payer: Pubkey,
    pub bump: u8,
}

impl AccessGrant {
    pub const SEED: &'static [u8] = b"grant";
}

/// Revoked grants are kept (not closed) to preserve the audit trail. One PDA
/// per (record, doctor): granting again re-activates the same account with a
/// new expiration and keeps `access_count` (team decision, 2026-10-04).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum GrantStatus {
    Active,
    Revoked,
}
