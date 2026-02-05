mod tool_test_utils;

use std::collections::HashSet;
use std::io::Cursor;

use kagent::config::ModelCapability;
use kagent::tools::file::{ReadMediaFile, ReadMediaParams};
use kosong::message::ContentPart;
use kosong::tooling::{CallableTool2, ToolOutput};

use tool_test_utils::RuntimeFixture;

fn parts_output(result: &kosong::tooling::ToolReturnValue) -> Vec<ContentPart> {
    match &result.output {
        ToolOutput::Parts(parts) => parts.clone(),
        _ => panic!("expected parts output"),
    }
}

#[tokio::test]
async fn test_read_image_file() {
    let fixture = RuntimeFixture::new();
    let tool = ReadMediaFile::new(&fixture.runtime).expect("read media tool");
    let image_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "sample.png";
    let data = b"\x89PNG\r\n\x1a\n"
        .iter()
        .copied()
        .chain(b"pngdata".iter().copied())
        .collect::<Vec<_>>();
    image_file
        .write_bytes(&data)
        .await
        .expect("write image file");

    let result = tool
        .call_typed(ReadMediaParams {
            path: image_file.to_string_lossy(),
        })
        .await;

    assert!(!result.is_error);
    let parts = parts_output(&result);
    assert_eq!(parts.len(), 3);
    match (&parts[0], &parts[1], &parts[2]) {
        (ContentPart::Text(open), ContentPart::ImageUrl(part), ContentPart::Text(close)) => {
            assert_eq!(
                open.text,
                format!("<image path=\"{}\">", image_file.to_string_lossy())
            );
            assert!(part.image_url.url.starts_with("data:image/png;base64,"));
            assert_eq!(close.text, "</image>");
        }
        _ => panic!("expected wrapped image part"),
    }
    assert_eq!(
        result.message,
        format!(
            "Loaded image file `{}` (image/png, {} bytes). If you need to output coordinates, output relative coordinates first and compute absolute coordinates using the original image size; if you generate or edit images/videos via commands or scripts, read the result back immediately before continuing.",
            image_file,
            data.len()
        )
    );
}

#[tokio::test]
async fn test_read_extensionless_image_file() {
    let fixture = RuntimeFixture::new();
    let tool = ReadMediaFile::new(&fixture.runtime).expect("read media tool");
    let image_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "sample";
    let data = b"\x89PNG\r\n\x1a\n"
        .iter()
        .copied()
        .chain(b"pngdata".iter().copied())
        .collect::<Vec<_>>();
    image_file
        .write_bytes(&data)
        .await
        .expect("write image file");

    let result = tool
        .call_typed(ReadMediaParams {
            path: image_file.to_string_lossy(),
        })
        .await;

    assert!(!result.is_error);
    let parts = parts_output(&result);
    assert_eq!(parts.len(), 3);
    match (&parts[0], &parts[1], &parts[2]) {
        (ContentPart::Text(open), ContentPart::ImageUrl(part), ContentPart::Text(close)) => {
            assert_eq!(
                open.text,
                format!("<image path=\"{}\">", image_file.to_string_lossy())
            );
            assert!(part.image_url.url.starts_with("data:image/png;base64,"));
            assert_eq!(close.text, "</image>");
        }
        _ => panic!("expected wrapped image part"),
    }
    assert_eq!(
        result.message,
        format!(
            "Loaded image file `{}` (image/png, {} bytes). If you need to output coordinates, output relative coordinates first and compute absolute coordinates using the original image size; if you generate or edit images/videos via commands or scripts, read the result back immediately before continuing.",
            image_file,
            data.len()
        )
    );
}

#[tokio::test]
async fn test_read_image_file_with_size() {
    let fixture = RuntimeFixture::new();
    let tool = ReadMediaFile::new(&fixture.runtime).expect("read media tool");
    let image_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "valid.png";

    let image = image::RgbImage::new(3, 4);
    let mut buffer = Vec::new();
    let mut cursor = Cursor::new(&mut buffer);
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut cursor, image::ImageFormat::Png)
        .expect("encode image");
    let data = buffer;
    image_file
        .write_bytes(&data)
        .await
        .expect("write image file");

    let result = tool
        .call_typed(ReadMediaParams {
            path: image_file.to_string_lossy(),
        })
        .await;

    assert!(!result.is_error);
    assert_eq!(
        result.message,
        format!(
            "Loaded image file `{}` (image/png, {} bytes, original size 3x4px). If you need to output coordinates, output relative coordinates first and compute absolute coordinates using the original image size; if you generate or edit images/videos via commands or scripts, read the result back immediately before continuing.",
            image_file,
            data.len()
        )
    );
}

#[tokio::test]
async fn test_read_video_file() {
    let fixture = RuntimeFixture::new();
    let tool = ReadMediaFile::new(&fixture.runtime).expect("read media tool");
    let video_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "sample.mp4";
    let data = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom".to_vec();
    video_file
        .write_bytes(&data)
        .await
        .expect("write video file");

    let result = tool
        .call_typed(ReadMediaParams {
            path: video_file.to_string_lossy(),
        })
        .await;

    assert!(!result.is_error);
    let parts = parts_output(&result);
    assert_eq!(parts.len(), 3);
    match (&parts[0], &parts[1], &parts[2]) {
        (ContentPart::Text(open), ContentPart::VideoUrl(part), ContentPart::Text(close)) => {
            assert_eq!(
                open.text,
                format!("<video path=\"{}\">", video_file.to_string_lossy())
            );
            assert!(part.video_url.url.starts_with("data:video/mp4;base64,"));
            assert_eq!(close.text, "</video>");
        }
        _ => panic!("expected wrapped video part"),
    }
    assert_eq!(
        result.message,
        format!(
            "Loaded video file `{}` (video/mp4, {} bytes). If you need to output coordinates, output relative coordinates first and compute absolute coordinates using the original image size; if you generate or edit images/videos via commands or scripts, read the result back immediately before continuing.",
            video_file,
            data.len()
        )
    );
}

#[tokio::test]
async fn test_read_text_file() {
    let fixture = RuntimeFixture::new();
    let tool = ReadMediaFile::new(&fixture.runtime).expect("read media tool");
    let text_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "sample.txt";
    text_file.write_text("hello").await.expect("write file");

    let result = tool
        .call_typed(ReadMediaParams {
            path: text_file.to_string_lossy(),
        })
        .await;

    assert!(result.is_error);
    assert_eq!(
        result.message,
        format!(
            "`{}` is a text file. Use ReadFile to read text files.",
            text_file
        )
    );
    assert_eq!(result.brief(), "Unsupported file type");
}

#[tokio::test]
async fn test_read_video_file_without_capability() {
    let mut capabilities = HashSet::new();
    capabilities.insert(ModelCapability::ImageIn);
    let fixture = RuntimeFixture::with_capabilities(capabilities);
    let tool = ReadMediaFile::new(&fixture.runtime).expect("read media tool");

    let video_file = fixture.runtime.builtin_args.KIMI_WORK_DIR.clone() / "sample.mp4";
    let data = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom".to_vec();
    video_file
        .write_bytes(&data)
        .await
        .expect("write video file");

    let result = tool
        .call_typed(ReadMediaParams {
            path: video_file.to_string_lossy(),
        })
        .await;

    assert!(result.is_error);
    assert_eq!(
        result.message,
        "The current model does not support video input. Tell the user to use a model with video input capability."
    );
    assert_eq!(result.brief(), "Unsupported media type");
}
