use anchor_lang::prelude::*;

use crate::errors::HcdError;
use crate::events::AccessGranted;
use crate::state::{
    AccessGrant, Config, GrantStatus, Provider, ProviderType, Record, RecordStatus,
};

/// Patient grants a doctor time-bound access to one Active record.
/// AccessGrant PDA seeds: ["grant", record, doctor]. expires_at must be in
/// the future and below Config.max_grant_duration_secs (checked vs Clock).
///
/// Granting again (after a revoke or an expiration) re-activates the same
/// account with a new expiration and keeps access_count (decision 2026-10-04).
#[derive(Accounts)]
#[instruction(doctor: Pubkey)]
pub struct GrantAccess<'info> {
    /// Pays the rent: the backend fee payer, so patients never need SOL.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub patient: Signer<'info>,
    #[account(seeds = [Config::SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [Record::SEED, record.patient.as_ref(), &record.record_id.to_le_bytes()],
        bump = record.bump,
        has_one = patient @ HcdError::Unauthorized,
        constraint = record.status == RecordStatus::Active @ HcdError::RecordNotActive,
    )]
    pub record: Account<'info, Record>,
    /// Access can only be granted to a verified doctor.
    #[account(
        seeds = [Provider::SEED, doctor.as_ref()],
        bump = doctor_provider.bump,
        constraint = doctor_provider.provider_type == ProviderType::Doctor @ HcdError::NotADoctor,
        constraint = doctor_provider.verified @ HcdError::ProviderNotVerified,
    )]
    pub doctor_provider: Account<'info, Provider>,
    #[account(
        init_if_needed,
        payer = payer,
        space = AccessGrant::DISCRIMINATOR.len() + AccessGrant::INIT_SPACE,
        seeds = [AccessGrant::SEED, record.key().as_ref(), doctor.as_ref()],
        bump
    )]
    pub grant: Account<'info, AccessGrant>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<GrantAccess>, doctor: Pubkey, expires_at: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(expires_at > now, HcdError::InvalidExpiration);
    require!(
        expires_at - now <= ctx.accounts.config.max_grant_duration_secs,
        HcdError::ExpirationTooLong
    );

    let record = ctx.accounts.record.key();
    let patient = ctx.accounts.patient.key();
    let grant = &mut ctx.accounts.grant;
    // A zeroed `record` means the account was just created.
    if grant.record == Pubkey::default() {
        grant.patient = patient;
        grant.doctor = doctor;
        grant.record = record;
        grant.access_count = 0;
        grant.rent_payer = ctx.accounts.payer.key();
        grant.bump = ctx.bumps.grant;
    }
    grant.expires_at = expires_at;
    grant.status = GrantStatus::Active;

    emit!(AccessGranted {
        grant: grant.key(),
        record,
        patient,
        doctor,
        expires_at,
    });
    Ok(())
}
