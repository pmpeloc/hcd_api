use anchor_lang::prelude::*;

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub key_service: Pubkey,
    pub max_grant_duration_secs: i64,
}

#[event]
pub struct RecordIssued {
    pub record: Pubkey,
    pub patient: Pubkey,
    pub issuer: Pubkey,
    pub record_id: u64,
}

#[event]
pub struct RecordDisputed {
    pub record: Pubkey,
    pub patient: Pubkey,
}

#[event]
pub struct RecordVoided {
    pub record: Pubkey,
    pub issuer: Pubkey,
}

#[event]
pub struct AccessGranted {
    pub grant: Pubkey,
    pub record: Pubkey,
    pub patient: Pubkey,
    pub doctor: Pubkey,
    pub expires_at: i64,
}

#[event]
pub struct AccessRevoked {
    pub grant: Pubkey,
    pub record: Pubkey,
    pub patient: Pubkey,
    pub doctor: Pubkey,
}

#[event]
pub struct AccessLogged {
    pub grant: Pubkey,
    pub record: Pubkey,
    pub doctor: Pubkey,
    pub access_count: u64,
}
