//! Chapter listing, inspection and advancement.
//!
//! Until now the API had no chapter routes at all: the editor synthesised its
//! chapter list from `chapter_count` alone, so the sidebar showed N identical
//! non-interactive rows that said nothing about whether a chapter had been
//! outlined, written, or reached. `ink_core` already knew all of it —
//! `maintenance::book_status` and `maintenance::advance_chapter` were simply
//! never wired to anything.

use std::path::{Path, PathBuf};

use axum::Json;
use axum::extract::{Path as AxumPath, State};
use serde::Serialize;

use super::books::load_owned_repo_path;
use crate::auth::CurrentUser;
use crate::blocking;
use crate::error::{AppError, AppResult, code};
use crate::state::AppState;

const CHAPTER_DIR: &str = "Chapters material";

#[derive(Debug, Serialize)]
pub struct ChapterSummary {
    pub number: u32,
    /// From the file's first `# ` heading, falling back to "Chapitre N".
    pub title: String,
    /// False for a chapter that is planned by `chapter_count` but has no
    /// outline file yet — the distinction the old UI could not draw.
    pub has_outline: bool,
    pub is_current: bool,
    /// Words in the outline, so an untouched template reads as empty.
    pub word_count: usize,
}

#[derive(Debug, Serialize)]
pub struct ChapterList {
    pub chapters: Vec<ChapterSummary>,
    pub current_chapter: u32,
    pub chapter_count: u32,
}

fn chapter_path(repo: &Path, number: u32) -> PathBuf {
    repo.join(CHAPTER_DIR)
        .join(format!("Chapter_{number:02}.md"))
}

/// The first markdown heading, if the author has replaced the template's.
fn title_from(content: &str, number: u32) -> String {
    content
        .lines()
        .find_map(|line| line.strip_prefix("# "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Chapitre {number}"))
}

/// Strips a leading markdown list marker (`-`, `*`, `+`, `1.`, `1)`), so the
/// placeholder inside a numbered beat is recognised as a placeholder.
fn strip_list_marker(line: &str) -> &str {
    if let Some(rest) = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* ").or_else(|| line.strip_prefix("+ ")))
    {
        return rest.trim_start();
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        let rest = &line[digits..];
        if let Some(rest) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            return rest.trim_start();
        }
    }
    line
}

/// Removes `[...]` placeholder spans. The scaffold writes its prompts that
/// way, including inside numbered beats.
fn strip_placeholders(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut depth = 0usize;
    for ch in line.chars() {
        match ch {
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

/// Counts only words the author actually wrote, so an untouched template
/// reports zero rather than looking like a written chapter. The scaffold is
/// made of headings, horizontal rules, whole-line italic instructions and
/// bracketed placeholders — sometimes nested inside numbered beats, which is
/// why the list marker has to come off before the placeholder check.
fn outline_word_count(content: &str) -> usize {
    content
        .lines()
        .map(str::trim)
        .filter(|t| !t.is_empty() && !t.starts_with('#') && !t.starts_with("---"))
        // A whole-line italic is an instruction to the author, not prose.
        .filter(|t| !(t.len() > 1 && t.starts_with('*') && t.ends_with('*')))
        .map(|t| strip_placeholders(strip_list_marker(t)))
        .flat_map(|t| t.split_whitespace().map(str::to_string).collect::<Vec<_>>())
        // Leftover punctuation from a stripped placeholder isn't a word.
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count()
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<ChapterList>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;

    let list = blocking::run(move || {
        let ctx = ink_core::context::get_book_context(&repo_path)?;
        let chapter_count = ctx.config.chapter_count;
        let current = ctx.config.current_chapter;

        let chapters = (1..=chapter_count)
            .map(|number| {
                let content = std::fs::read_to_string(chapter_path(&repo_path, number)).ok();
                ChapterSummary {
                    number,
                    title: content
                        .as_deref()
                        .map(|c| title_from(c, number))
                        .unwrap_or_else(|| format!("Chapitre {number}")),
                    has_outline: content.is_some(),
                    is_current: number == current,
                    word_count: content.as_deref().map(outline_word_count).unwrap_or(0),
                }
            })
            .collect();

        Ok::<_, anyhow::Error>(ChapterList {
            chapters,
            current_chapter: current,
            chapter_count,
        })
    })
    .await?;

    Ok(Json(list))
}

/// Full outline for one chapter — `context::load_chapter` has always been able
/// to load any chapter by number, but nothing ever called it with anything but
/// the active one.
pub async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    AxumPath((id, number)): AxumPath<(String, u32)>,
) -> AppResult<Json<serde_json::Value>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;

    let chapter =
        blocking::run(move || ink_core::context::load_chapter(&repo_path, number, &[])).await?;

    match chapter {
        Some(info) => Ok(Json(serde_json::json!({
            "number": number,
            "path": info.path,
            "content": info.content,
            "title": title_from(&info.content, number),
            "modified_today": info.modified_today,
        }))),
        None => Err(AppError::not_found(format!(
            "chapter {number} has no outline yet"
        ))),
    }
}

/// Book-wide progress. Everything here already existed in
/// `maintenance::book_status`; none of it had ever reached the browser.
pub async fn stats(
    State(state): State<AppState>,
    user: CurrentUser,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<serde_json::Value>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    let status = blocking::run(move || ink_core::maintenance::book_status(&repo_path)).await?;
    Ok(Json(status))
}

/// Moves the book on to the next chapter.
///
/// `advance_chapter` refuses in two ordinary situations rather than failing:
/// the current chapter is short of 90% of `words_per_chapter`, or the next
/// chapter has no outline. Both are states the author can act on, so they come
/// back as typed error codes carrying the numbers the UI needs to say what is
/// missing — not as a generic 500.
pub async fn advance(
    State(state): State<AppState>,
    user: CurrentUser,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<serde_json::Value>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    let result = blocking::run(move || ink_core::maintenance::advance_chapter(&repo_path)).await?;

    match result.get("status").and_then(|s| s.as_str()) {
        Some("chapter_not_ready") => Err(AppError::new(
            axum::http::StatusCode::CONFLICT,
            code::CHAPTER_NOT_READY,
            "le chapitre courant n'a pas encore atteint sa longueur cible",
        )
        .with_details(result)),
        Some("needs_chapter_outline") => Err(AppError::new(
            axum::http::StatusCode::CONFLICT,
            code::NEEDS_CHAPTER_OUTLINE,
            "le prochain chapitre n'a pas encore d'ébauche",
        )
        .with_details(result)),
        _ => Ok(Json(result)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_comes_from_the_first_heading() {
        assert_eq!(title_from("# La tempête\n\ntext", 3), "La tempête");
    }

    #[test]
    fn title_falls_back_when_there_is_no_heading() {
        assert_eq!(title_from("no heading here", 4), "Chapitre 4");
        assert_eq!(title_from("", 1), "Chapitre 1");
    }

    #[test]
    fn an_empty_heading_falls_back_rather_than_rendering_blank() {
        assert_eq!(title_from("# \n", 2), "Chapitre 2");
    }

    #[test]
    fn a_setext_style_hash_without_a_space_is_not_a_heading() {
        // "#Chapter" is not a markdown heading, and treating it as one would
        // put a stray title in the rail.
        assert_eq!(title_from("#Chapitre", 5), "Chapitre 5");
    }

    #[test]
    fn an_untouched_template_counts_as_empty() {
        // Every line of the scaffold is a heading, an italic instruction, a
        // bracketed placeholder or a rule.
        let template = "# Chapter 1\n\n*This file outlines Chapter 1 only.*\n\n---\n\n## Goal\n\n[What must happen?]\n";
        assert_eq!(outline_word_count(template), 0);
    }

    #[test]
    fn numbered_beats_wrapping_a_placeholder_still_count_as_empty() {
        // The real scaffold's Scene Beats section — this is what made a
        // freshly created chapter report 31 words.
        let beats = "## Scene Beats\n\n1. [Opening beat — where are we, who are we with?]\n2. [Rising tension or complication]\n3. [Turn or revelation]\n";
        assert_eq!(outline_word_count(beats), 0);
    }

    #[test]
    fn a_bulleted_placeholder_counts_as_empty_too() {
        assert_eq!(outline_word_count("- [who?]\n* [what?]\n+ [when?]\n"), 0);
    }

    #[test]
    fn prose_written_around_a_placeholder_is_counted() {
        // Half-filled beats should register progress.
        // "Le gardien monte l'escalier" — four words; the bracketed question
        // and its stray "?" contribute nothing.
        assert_eq!(
            outline_word_count("1. Le gardien monte l'escalier [combien de marches ?]\n"),
            4
        );
    }

    #[test]
    fn authored_prose_is_counted() {
        let outline = "# Chapter 1\n\n## Goal\n\nLe gardien doit quitter le phare.\n";
        assert_eq!(outline_word_count(outline), 6);
    }

    #[test]
    fn chapter_paths_are_zero_padded_to_two_digits() {
        let repo = Path::new("/books/x");
        assert!(chapter_path(repo, 1).ends_with("Chapters material/Chapter_01.md"));
        assert!(chapter_path(repo, 12).ends_with("Chapters material/Chapter_12.md"));
    }
}
