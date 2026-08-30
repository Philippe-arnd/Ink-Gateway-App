use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc;

use crate::crypto::Cipher;

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

pub struct Inner {
    pub db: SqlitePool,
    pub cipher: Cipher,
    /// Directory containing one git working copy per registered book.
    pub books_dir: PathBuf,
}

impl AppState {
    pub fn new(db: SqlitePool, cipher: Cipher, books_dir: PathBuf) -> Self {
        Self(Arc::new(Inner {
            db,
            cipher,
            books_dir,
        }))
    }
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
