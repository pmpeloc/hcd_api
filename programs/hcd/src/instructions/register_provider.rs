use anchor_lang::prelude::*;

use crate::errors::HcdError;

/// Provider self-registers (clinic or doctor). Provider PDA seeds:
/// ["provider", authority]. Born unverified; the admin verifies it.
#[derive(Accounts)]
pub struct RegisterProvider<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn handler(_ctx: Context<RegisterProvider>) -> Result<()> {
    err!(HcdError::Unimplemented)
}
