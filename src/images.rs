use std::{
    io::Cursor,
    path::{Path, PathBuf},
};

use anyhow::Context;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, codecs::jpeg::JpegEncoder, imageops::FilterType};

use crate::{auth::random_token, error::AppError};

/// Longest edge of the copy shown on the board.
const DISPLAY_MAX: u32 = 2560;
/// Longest edge of the small preview used in lists.
const THUMB_MAX: u32 = 480;

pub struct StoredImage {
    pub file_key: String,
    pub mime: &'static str,
    pub display_mime: &'static str,
    pub px_width: u32,
    pub px_height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    Original,
    Display,
    Thumb,
}

impl Variant {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "original" => Some(Self::Original),
            "display" => Some(Self::Display),
            "thumb" => Some(Self::Thumb),
            _ => None,
        }
    }
}

pub fn ext_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    }
}

pub fn path_for(dir: &Path, key: &str, variant: Variant, mime: &str) -> PathBuf {
    let tag = match variant {
        Variant::Original => "orig",
        Variant::Display => "display",
        Variant::Thumb => "thumb",
    };
    dir.join(format!("{key}.{tag}.{}", ext_for(mime)))
}

/// Validate an upload, keep the original and write resized web copies.
/// CPU heavy: call from a blocking thread.
pub fn store(dir: &Path, bytes: &[u8]) -> Result<StoredImage, AppError> {
    let format = image::guess_format(bytes).map_err(|_| unsupported())?;
    let mime = match format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png => "image/png",
        ImageFormat::WebP => "image/webp",
        ImageFormat::Gif => "image/gif",
        _ => return Err(unsupported()),
    };

    let mut decoder = ImageReader::with_format(Cursor::new(bytes), format)
        .into_decoder()
        .map_err(|e| AppError::bad(format!("Could not read this image: {e}")))?;
    let orientation = decoder.orientation().ok();
    let mut img =
        DynamicImage::from_decoder(decoder).map_err(|e| AppError::bad(format!("Could not read this image: {e}")))?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }

    let has_alpha = img.color().has_alpha();
    let display_mime = if has_alpha { "image/png" } else { "image/jpeg" };
    let key = random_token(12);

    std::fs::write(path_for(dir, &key, Variant::Original, mime), bytes).context("saving original")?;
    write_resized(&img, DISPLAY_MAX, &path_for(dir, &key, Variant::Display, display_mime), has_alpha)?;
    write_resized(&img, THUMB_MAX, &path_for(dir, &key, Variant::Thumb, display_mime), has_alpha)?;

    Ok(StoredImage { file_key: key, mime, display_mime, px_width: img.width(), px_height: img.height() })
}

fn write_resized(img: &DynamicImage, max: u32, path: &Path, has_alpha: bool) -> Result<(), AppError> {
    let resized;
    let img = if img.width() > max || img.height() > max {
        resized = img.resize(max, max, FilterType::CatmullRom);
        &resized
    } else {
        img
    };
    if has_alpha {
        img.to_rgba8().save_with_format(path, ImageFormat::Png).context("saving png copy")?;
    } else {
        let file = std::fs::File::create(path).context("creating jpeg copy")?;
        let mut out = std::io::BufWriter::new(file);
        JpegEncoder::new_with_quality(&mut out, 88).encode_image(&img.to_rgb8()).context("encoding jpeg copy")?;
    }
    Ok(())
}

pub fn remove(dir: &Path, key: &str, mime: &str, display_mime: &str) {
    for (variant, m) in [(Variant::Original, mime), (Variant::Display, display_mime), (Variant::Thumb, display_mime)] {
        let _ = std::fs::remove_file(path_for(dir, key, variant, m));
    }
}

fn unsupported() -> AppError {
    AppError::bad("Unsupported file. Upload JPEG, PNG, WebP or GIF images.")
}
