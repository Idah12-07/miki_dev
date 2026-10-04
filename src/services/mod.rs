//! Application/business-logic services.
//!
//! Handlers stay thin: they parse input, call a service, and map the
//! result. Services own workflows that span the database and external
//! providers (BTCPay).

pub mod invoice;
pub mod webhook;
