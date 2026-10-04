use anchor_lang::prelude::*;

use crate::errors::HcdError;

/// Patient marks the record as "not mine": Active -> Disputed.
#[derive(Accounts)]
pub struct DisputeRecord<'info> {
    #[account(mut)]
    pub patient: Signer<'info>,
}

pub fn handler(_ctx: Context<DisputeRecord>) -> Result<()> {
    err!(HcdError::Unimplemented)
}
