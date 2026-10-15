use anchor_lang::prelude::*;

/// A clinic or a doctor registered in the program. Seeds: ["provider", authority]
#[account]
#[derive(InitSpace)]
pub struct Provider {
    /// Wallet that controls this provider account.
    pub authority: Pubkey,
    pub provider_type: ProviderType,
    /// Only the admin can set this to true (manual license check off-chain).
    pub verified: bool,
    /// Organization the provider belongs to. For a clinic: its own pubkey.
    /// For a doctor: the clinic that endorses them (verified off-chain too).
    pub organization: Pubkey,
    pub bump: u8,
}

impl Provider {
    pub const SEED: &'static [u8] = b"provider";
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ProviderType {
    Clinic,
    Doctor,
}
