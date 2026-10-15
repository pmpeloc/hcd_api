use anchor_lang::prelude::*;

use crate::errors::HcdError;
use crate::events::AccessLogged;
use crate::state::{AccessGrant, Config, GrantStatus, Provider, Record, RecordStatus};

/// Called only by the key service (Config.key_service) each time it releases
/// a DEK. Requires an Active, unexpired grant on an Active record and a doctor
/// that is still verified (a suspension cuts access at once); increments
/// access_count and emits AccessLogged.
#[derive(Accounts)]
pub struct LogAccess<'info> {
    #[account(address = config.key_service @ HcdError::NotKeyService)]
    pub key_service: Signer<'info>,
    #[account(seeds = [Config::SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [AccessGrant::SEED, grant.record.as_ref(), grant.doctor.as_ref()],
        bump = grant.bump,
        constraint = grant.status == GrantStatus::Active @ HcdError::GrantNotActive,
    )]
    pub grant: Account<'info, AccessGrant>,
    #[account(
        address = grant.record,
        constraint = record.status != RecordStatus::Disputed @ HcdError::RecordDisputed,
        constraint = record.status != RecordStatus::Voided @ HcdError::RecordVoided,
    )]
    pub record: Account<'info, Record>,
    #[account(
        seeds = [Provider::SEED, grant.doctor.as_ref()],
        bump = doctor_provider.bump,
        constraint = doctor_provider.verified @ HcdError::ProviderNotVerified,
    )]
    pub doctor_provider: Account<'info, Provider>,
}

pub fn handler(ctx: Context<LogAccess>) -> Result<()> {
    let grant = &mut ctx.accounts.grant;
    // Clock, never a client timestamp.
    require!(
        Clock::get()?.unix_timestamp < grant.expires_at,
        HcdError::GrantExpired
    );
    grant.access_count = grant.access_count.checked_add(1).ok_or(HcdError::Overflow)?;

    emit!(AccessLogged {
        grant: grant.key(),
        record: grant.record,
        doctor: grant.doctor,
        access_count: grant.access_count,
    });
    Ok(())
}
