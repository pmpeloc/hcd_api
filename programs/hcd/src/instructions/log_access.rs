use anchor_lang::prelude::*;

use crate::errors::HcdError;

/// Called only by the key service (Config.key_service) each time it releases
/// a DEK. Requires an Active, unexpired grant; increments access_count and
/// emits AccessLogged.
#[derive(Accounts)]
pub struct LogAccess<'info> {
    #[account(mut)]
    pub key_service: Signer<'info>,
}

pub fn handler(_ctx: Context<LogAccess>) -> Result<()> {
    err!(HcdError::Unimplemented)
}
