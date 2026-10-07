use anchor_lang::prelude::*;

use crate::errors::HcdError;
use crate::events::RecordIssued;
use crate::state::{Config, PatientProfile, Provider, ProviderType, Record, RecordStatus};

/// A verified doctor issues a record; it is born Active. Record PDA seeds:
/// ["record", patient, record_id]. Only content_hash and an opaque
/// storage_ref go on-chain - never medical data.
///
/// Requires two signatures: the doctor and `key_service`. The backend only
/// co-signs after validating the patient's QR code, so a verified doctor
/// cannot skip the backend and load records into any wallet (decision
/// 2026-10-04).
#[derive(Accounts)]
pub struct IssueRecord<'info> {
    /// Pays the rent: the backend fee payer. Stored as `rent_payer`.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub issuer: Signer<'info>,
    #[account(address = config.key_service @ HcdError::NotKeyService)]
    pub key_service: Signer<'info>,
    #[account(seeds = [Config::SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [Provider::SEED, issuer.key().as_ref()],
        bump = issuer_provider.bump,
        constraint = issuer_provider.provider_type == ProviderType::Doctor @ HcdError::NotADoctor,
        constraint = issuer_provider.verified @ HcdError::ProviderNotVerified,
    )]
    pub issuer_provider: Account<'info, Provider>,
    #[account(
        mut,
        seeds = [PatientProfile::SEED, patient_profile.authority.as_ref()],
        bump = patient_profile.bump,
        constraint = patient_profile.authority != issuer.key() @ HcdError::IssuerIsPatient,
    )]
    pub patient_profile: Account<'info, PatientProfile>,
    #[account(
        init,
        payer = payer,
        space = Record::DISCRIMINATOR.len() + Record::INIT_SPACE,
        seeds = [
            Record::SEED,
            patient_profile.authority.as_ref(),
            &patient_profile.next_record_id.to_le_bytes(),
        ],
        bump
    )]
    pub record: Account<'info, Record>,
    /// Only for a re-issue: the voided record this one replaces. It must be
    /// voided and belong to the same patient and issuer.
    #[account(
        constraint = superseded_record.status == RecordStatus::Voided @ HcdError::RecordNotVoided,
        constraint = superseded_record.patient == patient_profile.authority @ HcdError::Unauthorized,
        constraint = superseded_record.issuer == issuer.key() @ HcdError::Unauthorized,
    )]
    pub superseded_record: Option<Account<'info, Record>>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<IssueRecord>,
    content_hash: [u8; 32],
    storage_ref: String,
) -> Result<()> {
    require!(content_hash != [0u8; 32], HcdError::InvalidContentHash);
    require!(is_lowercase_uuid(&storage_ref), HcdError::InvalidStorageRef);

    let profile = &mut ctx.accounts.patient_profile;
    let record_id = profile.next_record_id;
    profile.next_record_id = record_id.checked_add(1).ok_or(HcdError::Overflow)?;

    let patient = profile.authority;
    let issuer = ctx.accounts.issuer.key();
    ctx.accounts.record.set_inner(Record {
        patient,
        issuer,
        record_id,
        content_hash,
        storage_ref,
        status: RecordStatus::Active,
        created_at: Clock::get()?.unix_timestamp,
        rent_payer: ctx.accounts.payer.key(),
        supersedes: ctx.accounts.superseded_record.as_ref().map(|r| r.key()),
        bump: ctx.bumps.record,
    });

    emit!(RecordIssued {
        record: ctx.accounts.record.key(),
        patient,
        issuer,
        record_id,
    });
    Ok(())
}

/// `storage_ref` is the `records.id` UUID of the backend (decision
/// 2026-10-06): opaque, so no readable path or name can land on-chain.
/// Canonical form only: 36 chars, lowercase hex, dashes at 8, 13, 18, 23.
fn is_lowercase_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

#[cfg(test)]
mod tests {
    use super::is_lowercase_uuid;

    #[test]
    fn accepts_only_canonical_lowercase_uuids() {
        assert!(is_lowercase_uuid("3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c"));
        assert!(!is_lowercase_uuid("3F2B8C1E-9A4D-4E7B-8C2A-1D5E6F7A8B9C"));
        assert!(!is_lowercase_uuid("3f2b8c1e9a4d4e7b8c2a1d5e6f7a8b9c"));
        assert!(!is_lowercase_uuid("3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9"));
        assert!(!is_lowercase_uuid("pacientes/juan-perez/rx-pierna.pdf.enc"));
        assert!(!is_lowercase_uuid("3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9g"));
        assert!(!is_lowercase_uuid(""));
    }
}
