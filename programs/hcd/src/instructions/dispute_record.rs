use anchor_lang::prelude::*;

use crate::errors::HcdError;
use crate::events::RecordDisputed;
use crate::state::{Record, RecordStatus};

/// Patient marks the record as "not mine": Active -> Disputed.
#[derive(Accounts)]
pub struct DisputeRecord<'info> {
    pub patient: Signer<'info>,
    #[account(
        mut,
        seeds = [Record::SEED, record.patient.as_ref(), &record.record_id.to_le_bytes()],
        bump = record.bump,
        has_one = patient @ HcdError::Unauthorized,
        constraint = record.status == RecordStatus::Active @ HcdError::RecordNotActive,
    )]
    pub record: Account<'info, Record>,
}

pub fn handler(ctx: Context<DisputeRecord>) -> Result<()> {
    ctx.accounts.record.status = RecordStatus::Disputed;
    emit!(RecordDisputed {
        record: ctx.accounts.record.key(),
        patient: ctx.accounts.patient.key(),
    });
    Ok(())
}
