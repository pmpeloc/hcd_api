use anchor_lang::prelude::*;

use crate::errors::HcdError;

/// Admin flips Provider.verified. Used to verify and to suspend a provider
/// after a detected fraud ("emisor suspendido").
#[derive(Accounts)]
pub struct SetProviderVerified<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
}

pub fn handler(_ctx: Context<SetProviderVerified>, _verified: bool) -> Result<()> {
    err!(HcdError::Unimplemented)
}
