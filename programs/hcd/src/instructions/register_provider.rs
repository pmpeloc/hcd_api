use anchor_lang::prelude::*;

use crate::errors::HcdError;
use crate::state::{Provider, ProviderType};

/// Provider self-registers (clinic or doctor). Provider PDA seeds:
/// ["provider", authority]. Born unverified; the admin verifies it.
#[derive(Accounts)]
pub struct RegisterProvider<'info> {
    /// Pays the rent: the backend fee payer, so providers never need SOL.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Provider::DISCRIMINATOR.len() + Provider::INIT_SPACE,
        seeds = [Provider::SEED, authority.key().as_ref()],
        bump
    )]
    pub provider: Account<'info, Provider>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterProvider>,
    provider_type: ProviderType,
    organization: Pubkey,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    // The doctor-clinic link is endorsed off-chain and checked by the
    // admin before verifying; on-chain we only reject the obvious mismatches.
    let valid = match provider_type {
        ProviderType::Clinic => organization == authority,
        ProviderType::Doctor => organization != authority,
    };
    require!(valid, HcdError::InvalidOrganization);

    ctx.accounts.provider.set_inner(Provider {
        authority,
        provider_type,
        verified: false,
        organization,
        bump: ctx.bumps.provider,
    });
    Ok(())
}
