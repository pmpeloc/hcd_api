use anchor_lang::prelude::*;

/// Patient profile. Seeds: ["patient", authority]
#[account]
#[derive(InitSpace)]
pub struct PatientProfile {
    /// The patient's embedded wallet (Privy). No DNI is stored anywhere.
    pub authority: Pubkey,
    /// Monotonic counter used as seed for each new Record.
    pub next_record_id: u64,
    pub created_at: i64,
    pub bump: u8,
}
