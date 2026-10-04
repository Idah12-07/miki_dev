//! Liveness / readiness probe.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;

/// Returns 200 only when the database answers a round-trip query.
pub async fn health(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    let db_up = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await;

    match db_up {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({ "status": "ok", "database": "up" })),
        ),
        Err(err) => {
            tracing::error!(error = %err, "health check: database unreachable");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "unavailable", "database": "down" })),
            )
        }
    }
}
