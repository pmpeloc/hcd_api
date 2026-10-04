use anchor_lang::prelude::*;

use crate::errors::HcdError;

/// A verified doctor issues a record; it is born Active. Record PDA seeds:
/// ["record", patient, record_id]. Only content_hash and an opaque
/// storage_ref go on-chain - never medical data.
#[derive(Accounts)]
pub struct IssueRecord<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
}

pub fn handler(
    _ctx: Context<IssueRecord>,
    _content_hash: [u8; 32],
    _storage_ref: String,
) -> Result<()> {
    err!(HcdError::Unimplemented)
}
