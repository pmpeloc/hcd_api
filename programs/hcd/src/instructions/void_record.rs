use anchor_lang::prelude::*;

use crate::errors::HcdError;
use crate::events::RecordVoided;
use crate::state::{Record, RecordStatus};

/// Issuer voids a disputed record: Disputed -> Voided. The re-issue is a new
/// Record that points back via `supersedes`. No verified check on purpose: a
/// suspended issuer can still void its own disputed records.
#[derive(Accounts)]
pub struct VoidRecord<'info> {
    pub issuer: Signer<'info>,
    #[account(
        mut,
        seeds = [Record::SEED, record.patient.as_ref(), &record.record_id.to_le_bytes()],
        bump = record.bump,
        has_one = issuer @ HcdError::Unauthorized,
        constraint = record.status == RecordStatus::Disputed @ HcdError::RecordNotDisputed,
    )]
    pub record: Account<'info, Record>,
}

pub fn handler(ctx: Context<VoidRecord>) -> Result<()> {
    ctx.accounts.record.status = RecordStatus::Voided;
    emit!(RecordVoided {
        record: ctx.accounts.record.key(),
        issuer: ctx.accounts.issuer.key(),
    });
    Ok(())
}
