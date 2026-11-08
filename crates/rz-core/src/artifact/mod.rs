//! Content-addressed rule artifact.
//!
//! Layout (all integers little-endian):
//!   0   4  magic "RZA1"
//!   4   1  format version (1)
//!   5   1  flags (bit0 allow table, bit1 delta, bit2 bundle)
//!   6   2  header bytes (24)
//!   8   4  allow count
//!  12   4  block count
//!  16   4  total rules
//!  20   4  reserved (0)
//!  24  …  allow u64 × allowCount, sorted ascending
//!   …  …  block u64 × blockCount, sorted ascending
//!
//! The file bytes are deterministic for the same rule set, so the artifact id
//! is `sha256(file)`. The fingerprint function is xxhash64 seed 0, identical in
//! the TypeScript and Rust runtimes.

use std::time::SystemTime;

use std::fmt::Write as _;

use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::fingerprint::FingerprintTable;

pub const MAGIC: [u8; 4] = *b"RZA1";
pub const VERSION: u8 = 1;
pub const HEADER_BYTES: u16 = 24;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artifact {
    pub allow: Vec<u64>,
    pub block: Vec<u64>,
}

impl Artifact {
    pub fn from_table(table: FingerprintTable) -> Self {
        let (allow, block) = table.into_parts();
        Self { allow, block }
    }

    pub fn rules(&self) -> usize {
        self.allow.len() + self.block.len()
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_BYTES as usize + self.rules() * 8);
        out.extend_from_slice(&MAGIC);
        out.push(VERSION);
        out.push(u8::from(!self.allow.is_empty()));
        out.extend_from_slice(&HEADER_BYTES.to_le_bytes());
        out.extend_from_slice(&(self.allow.len() as u32).to_le_bytes());
        out.extend_from_slice(&(self.block.len() as u32).to_le_bytes());
        out.extend_from_slice(&(self.rules() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for value in &self.allow {
            out.extend_from_slice(&value.to_le_bytes());
        }
        for value in &self.block {
            out.extend_from_slice(&value.to_le_bytes());
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < HEADER_BYTES as usize {
            return Err("artifact shorter than header".into());
        }
        if bytes[0..4] != MAGIC {
            return Err("bad artifact magic".into());
        }
        if bytes[4] != VERSION {
            return Err(format!("unsupported artifact version {}", bytes[4]));
        }
        let header_bytes = u16::from_le_bytes([bytes[6], bytes[7]]) as usize;
        if header_bytes != HEADER_BYTES as usize {
            return Err(format!("unexpected header size {header_bytes}"));
        }
        let allow_count = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
        let block_count = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) as usize;
        let header_total =
            u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]) as usize;
        let total = allow_count
            .checked_add(block_count)
            .ok_or("artifact count overflow")?;
        if header_total != total {
            return Err("artifact total does not match counts".into());
        }
        let expected = header_bytes
            .checked_add(total.checked_mul(8).ok_or("artifact size overflow")?)
            .ok_or("artifact size overflow")?;
        if bytes.len() != expected {
            return Err("artifact length does not match header".into());
        }
        let mut allow = Vec::with_capacity(allow_count);
        let mut block = Vec::with_capacity(block_count);
        let mut offset = header_bytes;
        for index in 0..total {
            let value = u64::from_le_bytes(
                bytes[offset..offset + 8]
                    .try_into()
                    .map_err(|_| "truncated artifact")?,
            );
            offset += 8;
            if index < allow_count {
                allow.push(value);
            } else {
                block.push(value);
            }
        }
        Ok(Self { allow, block })
    }

    pub fn into_table(self) -> FingerprintTable {
        FingerprintTable::from_sorted(self.allow, self.block)
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Sidecar metadata stored next to the binary (and in `rule_artifacts`).
#[derive(Clone, Debug)]
pub struct ArtifactMeta {
    pub id: String,
    pub source: String,
    pub allow: usize,
    pub block: usize,
    pub bytes: usize,
    pub created_at: String,
}

impl ArtifactMeta {
    pub fn for_artifact(id: String, source: String, artifact: &Artifact, bytes: usize) -> Self {
        Self {
            id,
            source,
            allow: artifact.allow.len(),
            block: artifact.block.len(),
            bytes,
            created_at: OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_default(),
        }
    }

    pub fn to_json(&self) -> String {
        format!(
            "{{\"id\":\"{}\",\"source\":\"{}\",\"allow\":{},\"block\":{},\"rules\":{},\"bytes\":{},\"compiler\":\"rz-compile/0.1\",\"hash\":\"xxhash64/seed0\",\"createdAt\":\"{}\"}}",
            json_escape(&self.id),
            json_escape(&self.source),
            self.allow,
            self.block,
            self.allow + self.block,
            self.bytes,
            json_escape(&self.created_at)
        )
    }
}

fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out
}

mod s3;
#[cfg(test)]
mod tests;

pub use s3::S3Config;

/// Unused in the loaded path; kept for sidecar age checks in scripts.
pub fn age_seconds(modified: SystemTime) -> u64 {
    SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default()
        .as_secs()
}
