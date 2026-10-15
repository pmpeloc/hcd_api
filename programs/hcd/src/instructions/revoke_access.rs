use anchor_lang::prelude::*;

use crate::errors::HcdError;
use crate::events::AccessRevoked;
use crate::state::{AccessGrant, GrantStatus};

/// Patient revokes a grant: Active -> Revoked. The account stays open to
/// preserve the audit trail.
#[derive(Accounts)]
pub struct RevokeAccess<'info> {
    pub patient: Signer<'info>,
    #[account(
        mut,
        seeds = [AccessGrant::SEED, grant.record.as_ref(), grant.doctor.as_ref()],
        bump = grant.bump,
        has_one = patient @ HcdError::Unauthorized,
        constraint = grant.status == GrantStatus::Active @ HcdError::GrantNotActive,
    )]
    pub grant: Account<'info, AccessGrant>,
}

pub fn handler(ctx: Context<RevokeAccess>) -> Result<()> {
    let grant = &mut ctx.accounts.grant;
    grant.status = GrantStatus::Revoked;
    emit!(AccessRevoked {
        grant: grant.key(),
        record: grant.record,
        patient: grant.patient,
        doctor: grant.doctor,
    });
    Ok(())
}
