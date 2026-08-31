/// A book slug is a directory name under `books_dir`, never a raw path — this
/// is the only validation standing between a client-supplied string and the
/// server's filesystem, so every route that turns a slug into a path must
/// call it first.
pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
