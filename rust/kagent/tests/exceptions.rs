use kagent::config::ModelCapability;
use kagent::soul::{LLMNotSet, LLMNotSupported, MaxStepsReached};

#[test]
fn test_soul_exceptions() {
    let err = LLMNotSet;
    assert_eq!(err.to_string(), "LLM not set");

    let err = LLMNotSupported::new("mock", vec![ModelCapability::ImageIn]);
    assert_eq!(
        err.to_string(),
        "LLM model 'mock' does not support required capability: image_in."
    );

    let err = MaxStepsReached::new(10);
    assert_eq!(err.to_string(), "Max number of steps reached: 10");
}
