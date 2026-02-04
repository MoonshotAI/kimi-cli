use kagent::utils::Environment;

#[tokio::test]
async fn test_environment_detection() {
    let env = Environment::detect().await;

    assert!(!env.os_kind.is_empty());
    assert!(!env.os_arch.is_empty());
    assert!(!env.os_version.is_empty());

    if env.os_kind == "Windows" {
        assert_eq!(env.shell_name, "Windows PowerShell");
        assert_eq!(env.shell_path.to_string_lossy(), "powershell.exe");
    } else {
        assert!(env.shell_name == "bash" || env.shell_name == "sh");
        let shell_path = env.shell_path.to_string_lossy();
        assert!(!shell_path.is_empty());
        if env.shell_name == "bash" {
            assert!(shell_path.ends_with("bash"));
        } else {
            assert!(shell_path.ends_with("sh"));
        }
    }
}
