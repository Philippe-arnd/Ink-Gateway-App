//! `ink_core` does synchronous filesystem + git-subprocess I/O — run it on
//! the blocking thread pool so it never stalls the async runtime.

use anyhow::{Context, Result};

pub async fn run<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .context("blocking task panicked")?
}
