use anchor_lang::prelude::*;

use crate::errors::HcdError;

/// Issuer voids a disputed record: Disputed -> Voided. The re-issue is a new
/// Record that points back via `supersedes`.
#[derive(Accounts)]
pub struct VoidRecord<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
}

pub fn handler(_ctx: Context<VoidRecord>) -> Result<()> {
    err!(HcdError::Unimplemented)
}
