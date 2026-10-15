use anchor_lang::prelude::*;

#[error_code]
pub enum HcdError {
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
    #[msg("Signer is not the configured key service.")]
    NotKeyService,
    #[msg("Numerical overflow.")]
    Overflow,
    #[msg("Max grant duration must be greater than zero.")]
    InvalidGrantDuration,
    #[msg("A clinic's organization must be itself; a doctor's must be another account.")]
    InvalidOrganization,
    #[msg("Only a doctor can issue records.")]
    NotADoctor,
    #[msg("Storage ref must be a lowercase UUID.")]
    InvalidStorageRef,
    #[msg("Only a voided record can be superseded.")]
    RecordNotVoided,
    #[msg("Only a disputed record can be voided.")]
    RecordNotDisputed,
    #[msg("The key service must be a different key from the admin.")]
    KeyServiceIsAdmin,
    #[msg("A doctor cannot issue a record to themselves.")]
    IssuerIsPatient,
    #[msg("Content hash cannot be all zeros.")]
    InvalidContentHash,
}
