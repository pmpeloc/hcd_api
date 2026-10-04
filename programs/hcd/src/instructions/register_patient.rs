use anchor_lang::prelude::*;

use crate::state::PatientProfile;

/// Patient registers their profile. PatientProfile PDA seeds:
/// ["patient", authority]. Initializes next_record_id.
#[derive(Accounts)]
pub struct RegisterPatient<'info> {
    /// Pays the rent: the backend fee payer, so patients never need SOL.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = PatientProfile::DISCRIMINATOR.len() + PatientProfile::INIT_SPACE,
        seeds = [PatientProfile::SEED, authority.key().as_ref()],
        bump
    )]
    pub patient_profile: Account<'info, PatientProfile>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RegisterPatient>) -> Result<()> {
    ctx.accounts.patient_profile.set_inner(PatientProfile {
        authority: ctx.accounts.authority.key(),
        next_record_id: 0,
        created_at: Clock::get()?.unix_timestamp,
        bump: ctx.bumps.patient_profile,
    });
    Ok(())
}
