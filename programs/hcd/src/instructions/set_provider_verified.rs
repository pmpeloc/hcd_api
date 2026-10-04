use anchor_lang::prelude::*;

use crate::errors::HcdError;
use crate::state::{Config, Provider};

/// Admin flips Provider.verified. Used to verify and to suspend a provider
/// after a detected fraud ("emisor suspendido").
#[derive(Accounts)]
pub struct SetProviderVerified<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [Config::SEED], bump = config.bump, has_one = admin @ HcdError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [Provider::SEED, provider.authority.as_ref()], bump = provider.bump)]
    pub provider: Account<'info, Provider>,
}

pub fn handler(ctx: Context<SetProviderVerified>, verified: bool) -> Result<()> {
    ctx.accounts.provider.verified = verified;
    Ok(())
}
