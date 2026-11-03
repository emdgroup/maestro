//! The rules for sending a file to an agent: which files are images or PDFs, the mime type each is
//! announced with, and how large an image may be. The app applies them to files the user attaches
//! and the daemon to a task's attachments, so both decide alike.

use std::path::Path;

/// An image larger than this is refused rather than sent.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// An image larger than this is scaled down to about this size before it is sent.
pub const SCALE_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024;

fn extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

pub fn mime_for_extension(path: &str) -> Option<&'static str> {
    Some(match extension(path).as_str() {
        "rs" => "text/x-rust",
        "ts" | "tsx" => "text/typescript",
        "js" | "jsx" => "text/javascript",
        "py" => "text/x-python",
        "go" => "text/x-go",
        "rb" => "text/x-ruby",
        "java" => "text/x-java",
        "c" | "h" => "text/x-c",
        "cpp" => "text/x-c++",
        "toml" => "text/x-toml",
        "json" => "application/json",
        "md" => "text/markdown",
        "yaml" | "yml" => "text/yaml",
        "sh" => "text/x-sh",
        "html" => "text/html",
        "css" => "text/css",
        "sql" => "text/x-sql",
        "graphql" => "text/x-graphql",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

pub fn is_image_extension(path: &str) -> bool {
    matches!(
        extension(path).as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "tiff" | "bmp" | "ico" | "svg"
    )
}

pub fn is_pdf_extension(path: &str) -> bool {
    extension(path) == "pdf"
}

/// Why an image of `size` bytes cannot be sent, phrased for the user, or `None` when it can.
pub fn image_too_large(size: u64) -> Option<String> {
    (size > MAX_IMAGE_BYTES).then(|| {
        format!(
            "Image too large ({} MB, max {} MB)",
            size / 1_048_576,
            MAX_IMAGE_BYTES / 1_048_576
        )
    })
}

/// An image over [`SCALE_THRESHOLD_BYTES`] scaled down to about that size, re-encoded as PNG.
/// Anything within the threshold, or so close to it that scaling would gain little, is returned
/// untouched. The size limit is the caller's, through [`image_too_large`].
#[cfg(feature = "image")]
pub fn scale_image(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let size = bytes.len() as u64;
    if size <= SCALE_THRESHOLD_BYTES {
        return Ok(bytes);
    }
    let ratio = (SCALE_THRESHOLD_BYTES as f64 / size as f64).sqrt();
    if ratio >= 0.9 {
        return Ok(bytes);
    }
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let resized = img.resize(
        (img.width() as f64 * ratio) as u32,
        (img.height() as f64 * ratio) as u32,
        image::imageops::FilterType::Triangle,
    );
    let mut output = Vec::new();
    resized
        .write_to(
            &mut std::io::Cursor::new(&mut output),
            image::ImageFormat::Png,
        )
        .map_err(|e| e.to_string())?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_are_matched_whatever_their_case() {
        assert_eq!(mime_for_extension("a/b.RS"), Some("text/x-rust"));
        assert_eq!(mime_for_extension("shot.JPEG"), Some("image/jpeg"));
        assert_eq!(mime_for_extension("notes"), None);
        assert!(is_image_extension("x.PNG"));
        assert!(is_image_extension("x.bmp"));
        assert!(!is_image_extension("x.pdf"));
        assert!(is_pdf_extension("Spec.PDF"));
        assert!(!is_pdf_extension("pdf"));
    }

    #[test]
    fn an_image_over_the_limit_is_refused_with_its_size() {
        assert_eq!(image_too_large(MAX_IMAGE_BYTES), None);
        assert_eq!(
            image_too_large(12 * 1024 * 1024).as_deref(),
            Some("Image too large (12 MB, max 10 MB)")
        );
    }
}
