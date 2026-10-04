use anchor_lang::prelude::*;

/// A health record issued by a verified doctor.
/// Seeds: ["record", patient, record_id.to_le_bytes()]
#[account]
#[derive(InitSpace)]
pub struct Record {
    /// Patient this record belongs to (their authority pubkey).
    pub patient: Pubkey,
    /// Doctor who issued the record. The issuer can re-read it without a grant.
    pub issuer: Pubkey,
    pub record_id: u64,
    /// SHA-256 of the encrypted file. Never medical data itself.
    pub content_hash: [u8; 32],
    /// Opaque pointer to the ciphertext in off-chain storage (no readable path).
    #[max_len(64)]
    pub storage_ref: String,
    pub status: RecordStatus,
    pub created_at: i64,
    /// Account that paid the rent; receives it back if the account is closed.
    pub rent_payer: Pubkey,
    /// When the issuer voids and re-issues a record, points to the voided one.
    pub supersedes: Option<Pubkey>,
    pub bump: u8,
}

/// Active when issued. The patient can dispute it ("not mine"); the issuer can
/// void a disputed record and re-issue a new one. Nothing edits a record.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RecordStatus {
    Active,
    Disputed,
    Voided,
}
