use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("8FNP6rs3DQ4h6bqWNeD9meHt5mUNEhcaXbrbJxSJniyd");

#[program]
pub mod hcd {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        key_service: Pubkey,
        max_grant_duration_secs: i64,
    ) -> Result<()> {
        instructions::initialize_config::handler(ctx, key_service, max_grant_duration_secs)
    }

    pub fn register_provider(
        ctx: Context<RegisterProvider>,
        provider_type: state::ProviderType,
        organization: Pubkey,
    ) -> Result<()> {
        instructions::register_provider::handler(ctx, provider_type, organization)
    }

    pub fn set_provider_verified(
        ctx: Context<SetProviderVerified>,
        verified: bool,
    ) -> Result<()> {
        instructions::set_provider_verified::handler(ctx, verified)
    }

    pub fn register_patient(ctx: Context<RegisterPatient>) -> Result<()> {
        instructions::register_patient::handler(ctx)
    }

    pub fn issue_record(
        ctx: Context<IssueRecord>,
        content_hash: [u8; 32],
        storage_ref: String,
    ) -> Result<()> {
        instructions::issue_record::handler(ctx, content_hash, storage_ref)
    }

    pub fn dispute_record(ctx: Context<DisputeRecord>) -> Result<()> {
        instructions::dispute_record::handler(ctx)
    }

    pub fn void_record(ctx: Context<VoidRecord>) -> Result<()> {
        instructions::void_record::handler(ctx)
    }

    pub fn grant_access(
        ctx: Context<GrantAccess>,
        doctor: Pubkey,
        expires_at: i64,
    ) -> Result<()> {
        instructions::grant_access::handler(ctx, doctor, expires_at)
    }

    pub fn revoke_access(ctx: Context<RevokeAccess>) -> Result<()> {
        instructions::revoke_access::handler(ctx)
    }

    pub fn log_access(ctx: Context<LogAccess>) -> Result<()> {
        instructions::log_access::handler(ctx)
    }
}
