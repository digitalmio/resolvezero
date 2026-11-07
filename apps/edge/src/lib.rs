//! ResolveZero edge — Rust data plane.
//!
//! Ported from `apps/edge/src/*.ts`. Shared artifact/parser/database code lives
//! in the `rz-core` and `rz-db` workspace crates so the compiler uses the same
//! implementation as the edge.

pub mod cache;
pub mod config;
pub mod dns;
pub mod lazy;
pub mod limits;
pub mod lists;
pub mod metrics;
pub mod server;
pub mod services;
pub mod stats;
pub mod store;
pub mod upstream;
