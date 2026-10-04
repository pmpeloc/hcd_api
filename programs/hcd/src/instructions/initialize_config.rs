use anchor_lang::prelude::*;

use crate::errors::HcdError;

/// Admin-only one-time setup. Config PDA seeds: ["config"].
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
}

pub fn handler(
    _ctx: Context<InitializeConfig>,
    _key_service: Pubkey,
    _max_grant_duration_secs: i64,
) -> Result<()> {
    err!(HcdError::Unimplemented)
}
