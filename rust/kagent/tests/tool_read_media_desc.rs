mod tool_test_utils;

use std::collections::HashSet;

use kagent::config::ModelCapability;
use kagent::tools::SkipThisTool;
use kagent::tools::file::ReadMediaFile;
use kosong::tooling::CallableTool2;

use tool_test_utils::RuntimeFixture;

#[test]
fn test_read_media_file_description_by_capabilities() {
    let mut caps = HashSet::new();
    caps.insert(ModelCapability::ImageIn);
    caps.insert(ModelCapability::VideoIn);
    let fixture = RuntimeFixture::with_capabilities(caps);
    let tool = ReadMediaFile::new(&fixture.runtime).expect("read media tool");
    assert_eq!(
        tool.description(),
        "\
Read media content from a file.\n\
\n\
**Tips:**\n\
- Make sure you follow the description of each tool parameter.\n\
- A `<system>` tag will be given before the read file content.\n\
- The system will notify you when there is anything wrong when reading the file.\n\
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.\n\
- This tool can only read image or video files. To read other types of files, use the ReadFile tool. To list directories, use the Glob tool or `ls` command via the Shell tool.\n\
- If the file doesn't exist or path is invalid, an error will be returned.\n\
- The maximum size that can be read is 100MB. An error will be returned if the file is larger than this limit.\n\
- The media content will be returned in a form that you can directly view and understand.\n\
\n\
**Capabilities**\n\
- This tool supports image and video files for the current model.\n"
    );

    let mut caps = HashSet::new();
    caps.insert(ModelCapability::ImageIn);
    let fixture = RuntimeFixture::with_capabilities(caps);
    let tool = ReadMediaFile::new(&fixture.runtime).expect("read media tool");
    assert_eq!(
        tool.description(),
        "\
Read media content from a file.\n\
\n\
**Tips:**\n\
- Make sure you follow the description of each tool parameter.\n\
- A `<system>` tag will be given before the read file content.\n\
- The system will notify you when there is anything wrong when reading the file.\n\
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.\n\
- This tool can only read image or video files. To read other types of files, use the ReadFile tool. To list directories, use the Glob tool or `ls` command via the Shell tool.\n\
- If the file doesn't exist or path is invalid, an error will be returned.\n\
- The maximum size that can be read is 100MB. An error will be returned if the file is larger than this limit.\n\
- The media content will be returned in a form that you can directly view and understand.\n\
\n\
**Capabilities**\n\
- This tool supports image files for the current model.\n\
- Video files are not supported by the current model.\n"
    );

    let mut caps = HashSet::new();
    caps.insert(ModelCapability::VideoIn);
    let fixture = RuntimeFixture::with_capabilities(caps);
    let tool = ReadMediaFile::new(&fixture.runtime).expect("read media tool");
    assert_eq!(
        tool.description(),
        "\
Read media content from a file.\n\
\n\
**Tips:**\n\
- Make sure you follow the description of each tool parameter.\n\
- A `<system>` tag will be given before the read file content.\n\
- The system will notify you when there is anything wrong when reading the file.\n\
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.\n\
- This tool can only read image or video files. To read other types of files, use the ReadFile tool. To list directories, use the Glob tool or `ls` command via the Shell tool.\n\
- If the file doesn't exist or path is invalid, an error will be returned.\n\
- The maximum size that can be read is 100MB. An error will be returned if the file is larger than this limit.\n\
- The media content will be returned in a form that you can directly view and understand.\n\
\n\
**Capabilities**\n\
- This tool supports video files for the current model.\n\
- Image files are not supported by the current model.\n"
    );
}

#[test]
fn test_read_media_file_description_without_capabilities() {
    let caps = HashSet::new();
    let fixture = RuntimeFixture::with_capabilities(caps);
    let result = ReadMediaFile::new(&fixture.runtime);
    assert!(matches!(result, Err(SkipThisTool)));
}
