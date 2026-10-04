use anchor_lang::prelude::*;

use crate::errors::HcdError;

/// Patient revokes a grant: Active -> Revoked. The account stays open to
/// preserve the audit trail.
#[derive(Accounts)]
pub struct RevokeAccess<'info> {
    #[account(mut)]
    pub patient: Signer<'info>,
}

pub fn handler(_ctx: Context<RevokeAccess>) -> Result<()> {
    err!(HcdError::Unimplemented)
}
