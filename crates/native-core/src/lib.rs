pub fn runtime_name() -> &'static str {
    "chenkoai-native-core"
}

pub fn local_capabilities() -> Vec<&'static str> {
    vec![
        "secure-file-access",
        "desktop-runtime",
        "future-local-inference",
    ]
}
