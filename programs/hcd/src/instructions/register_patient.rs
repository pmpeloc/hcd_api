use anchor_lang::prelude::*;

use crate::errors::HcdError;

/// Patient registers their profile. PatientProfile PDA seeds:
/// ["patient", authority]. Initializes next_record_id.
#[derive(Accounts)]
pub struct RegisterPatient<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn handler(_ctx: Context<RegisterPatient>) -> Result<()> {
    err!(HcdError::Unimplemented)
}
