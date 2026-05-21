use std::path::Path;

use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, AeadCore, KeyInit, OsRng},
};
use keyring::Entry;
use sha2::{Digest, Sha256};

use crate::ticketing::token_manager::StoredToken;

pub struct KeychainStore;
