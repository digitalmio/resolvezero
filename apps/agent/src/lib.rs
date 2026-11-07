#![forbid(unsafe_code)]
//! Local DNS-to-DoH forwarder for ResolveZero.
//!
//! The agent ships as a single static binary without a JavaScript runtime.

pub mod config;
pub mod dns;
pub mod doh;
pub mod log;
pub mod server;
