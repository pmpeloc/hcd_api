use anchor_lang::prelude::*;

use crate::errors::HcdError;

/// Patient grants a doctor time-bound access to one Active record.
/// AccessGrant PDA seeds: ["grant", record, doctor]. expires_at must be in
/// the future and below Config.max_grant_duration_secs (checked vs Clock).
#[derive(Accounts)]
pub struct GrantAccess<'info> {
    #[account(mut)]
    pub patient: Signer<'info>,
}

pub fn handler(
    _ctx: Context<GrantAccess>,
    _doctor: Pubkey,
    _expires_at: i64,
) -> Result<()> {
    err!(HcdError::Unimplemented)
}
