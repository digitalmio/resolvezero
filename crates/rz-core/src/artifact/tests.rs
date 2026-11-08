use super::*;
use crate::fingerprint::FingerprintTable;
use std::collections::HashSet;

fn artifact() -> Artifact {
    let blocks: HashSet<String> = ["ads.example", "tracker.example"]
        .into_iter()
        .map(str::to_string)
        .collect();
    let allows: HashSet<String> = ["good.example"].into_iter().map(str::to_string).collect();
    Artifact::from_table(FingerprintTable::build(&blocks, &allows))
}

#[test]
fn roundtrips_and_is_deterministic() {
    let artifact = artifact();
    let bytes = artifact.encode();
    let decoded = Artifact::decode(&bytes).unwrap();
    assert_eq!(decoded, artifact);
    assert_eq!(artifact.encode(), bytes);
    assert_eq!(bytes.len(), HEADER_BYTES as usize + artifact.rules() * 8);
}

#[test]
fn rejects_bad_input() {
    assert!(Artifact::decode(b"nope").is_err());
    let mut bytes = artifact().encode();
    bytes[0] = b'X';
    assert!(Artifact::decode(&bytes).is_err());
    let mut bytes = artifact().encode();
    bytes[4] = 9;
    assert!(Artifact::decode(&bytes).is_err());
}

#[test]
fn id_is_sha256_of_the_file() {
    let bytes = artifact().encode();
    assert_eq!(sha256_hex(&bytes).len(), 64);
    assert_eq!(sha256_hex(&bytes), sha256_hex(&bytes));
}

#[test]
fn sidecar_is_valid_json_shape() {
    let artifact = artifact();
    let bytes = artifact.encode();
    let meta = ArtifactMeta::for_artifact(
        sha256_hex(&bytes),
        "https://example/list".into(),
        &artifact,
        bytes.len(),
    );
    let json = meta.to_json();
    assert!(json.contains("\"rules\":3"));
    assert!(json.contains("xxhash64/seed0"));
}
