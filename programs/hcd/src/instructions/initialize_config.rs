use anchor_lang::prelude::*;

use crate::errors::HcdError;
use crate::program::Hcd;
use crate::state::Config;

/// One-time setup. Config PDA seeds: ["config"].
/// Only the program's upgrade authority can call it, so nobody can front-run
/// the deploy and take the admin role.
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = Config::DISCRIMINATOR.len() + Config::INIT_SPACE,
        seeds = [Config::SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, Hcd>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ HcdError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeConfig>,
    key_service: Pubkey,
    max_grant_duration_secs: i64,
) -> Result<()> {
    require!(max_grant_duration_secs > 0, HcdError::InvalidGrantDuration);

    ctx.accounts.config.set_inner(Config {
        admin: ctx.accounts.admin.key(),
        key_service,
        max_grant_duration_secs,
        bump: ctx.bumps.config,
    });
    Ok(())
}
