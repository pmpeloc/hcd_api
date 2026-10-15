use anchor_lang::prelude::*;

use crate::errors::HcdError;
use crate::events::ConfigUpdated;
use crate::state::Config;

/// Admin replaces the Config values. Rotates a leaked `key_service`, hands
/// the admin role to another wallet, or changes the max grant duration.
/// Existing grants keep their expiration.
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [Config::SEED], bump = config.bump, has_one = admin @ HcdError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn handler(
    ctx: Context<UpdateConfig>,
    admin: Pubkey,
    key_service: Pubkey,
    max_grant_duration_secs: i64,
) -> Result<()> {
    require!(max_grant_duration_secs > 0, HcdError::InvalidGrantDuration);
    // The audit is only worth something if the admin can't also log accesses.
    require_keys_neq!(admin, key_service, HcdError::KeyServiceIsAdmin);

    let config = &mut ctx.accounts.config;
    config.admin = admin;
    config.key_service = key_service;
    config.max_grant_duration_secs = max_grant_duration_secs;

    emit!(ConfigUpdated {
        admin,
        key_service,
        max_grant_duration_secs,
    });
    Ok(())
}
