//! Order endpoints: create and retrieve.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

use crate::error::ApiError;
use crate::models::order::{self, NewOrder, Order, OrderDetail};
use crate::services;
use crate::services::invoice::InvoicePaymentInfo;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateOrderRequest {
    pub email: String,
    pub name: Option<String>,
    /// Amount in minor units (cents, satoshis).
    pub amount: i64,
    /// ISO 4217 code, e.g. `USD`.
    pub currency: String,
    pub description: Option<String>,
}

impl CreateOrderRequest {
    /// Normalise and validate before any SQL runs, so the client gets a
    /// readable 400 instead of a database constraint error.
    fn into_new_order(self) -> Result<NewOrder, ApiError> {
        let email = self.email.trim().to_lowercase();
        if email.is_empty() || !email.contains('@') || email.starts_with('@') || email.contains(' ')
        {
            return Err(ApiError::BadRequest(
                "email must be a valid address".to_string(),
            ));
        }

        if self.amount <= 0 {
            return Err(ApiError::BadRequest(
                "amount must be greater than zero, expressed in minor units".to_string(),
            ));
        }

        let currency = self.currency.trim().to_uppercase();
        if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err(ApiError::BadRequest(
                "currency must be a 3-letter ISO 4217 code, e.g. USD".to_string(),
            ));
        }

        if self.description.as_deref().is_some_and(|d| d.len() > 255) {
            return Err(ApiError::BadRequest(
                "description must be 255 characters or fewer".to_string(),
            ));
        }

        Ok(NewOrder {
            email,
            name: self.name,
            amount: self.amount,
            currency,
            description: self.description,
        })
    }
}

pub async fn create_order(
    State(state): State<AppState>,
    Json(request): Json<CreateOrderRequest>,
) -> Result<(StatusCode, Json<Order>), ApiError> {
    let input = request.into_new_order()?;
    let order = order::create(&state.pool, input).await?;

    tracing::info!(
        order_number = %order.order_number,
        amount = order.amount,
        currency = %order.currency,
        "order created"
    );

    Ok((StatusCode::CREATED, Json(order)))
}

pub async fn get_order(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<OrderDetail>, ApiError> {
    Ok(Json(order::find_detail(&state.pool, id).await?))
}

/// `POST /api/v1/orders/{order_id}/invoice`
///
/// Creates (or reuses) a BTCPay invoice for the stored order. The
/// handler is deliberately thin: no request body is read, so the client
/// can never influence the amount or currency — those come from the
/// stored order inside the service.
pub async fn create_invoice(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<(StatusCode, Json<InvoicePaymentInfo>), ApiError> {
    let btcpay = state.btcpay.as_ref().ok_or(ApiError::NotConfigured)?;

    let (info, created) = services::invoice::create_for_order(&state.pool, btcpay, id).await?;

    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(info)))
}
