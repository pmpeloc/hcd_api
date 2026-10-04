use anchor_lang::prelude::*;

#[error_code]
pub enum HcdError {
    #[msg("Instruction not implemented yet.")]
    Unimplemented,
    #[msg("Signer is not authorized for this action.")]
    Unauthorized,
    #[msg("Provider is not verified.")]
    ProviderNotVerified,
    #[msg("Record is not active.")]
    RecordNotActive,
    #[msg("Record is disputed.")]
    RecordDisputed,
    #[msg("Record is voided.")]
    RecordVoided,
    #[msg("Grant expiration must be in the future.")]
    InvalidExpiration,
    #[msg("Grant expiration exceeds the configured maximum.")]
    ExpirationTooLong,
    #[msg("Access grant is not active.")]
    GrantNotActive,
    #[msg("Access grant has expired.")]
    GrantExpired,
    #[msg("Only the key service can log access.")]
    NotKeyService,
    #[msg("Numerical overflow.")]
    Overflow,
    #[msg("Max grant duration must be greater than zero.")]
    InvalidGrantDuration,
    #[msg("A clinic's organization must be itself; a doctor's must be another account.")]
    InvalidOrganization,
}
