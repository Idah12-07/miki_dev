//! `users` table.

use chrono::NaiveDateTime;
use serde::Serialize;
use sqlx::{MySql, Transaction};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub email: String,
    pub name: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

pub async fn find_by_id<'e, E>(executor: E, id: i64) -> Result<Option<User>, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = MySql>,
{
    sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(executor)
        .await
}

/// Insert the user if the email is new, otherwise return the existing row.
///
/// `ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)` keeps this atomic: two
/// concurrent requests with the same email both get the same id instead of
/// one failing on the unique constraint.
pub async fn find_or_create(
    tx: &mut Transaction<'_, MySql>,
    email: &str,
    name: Option<&str>,
) -> Result<User, sqlx::Error> {
    sqlx::query(
        "INSERT INTO users (email, name) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
    )
    .bind(email)
    .bind(name)
    .execute(tx.as_mut())
    .await?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = ?")
        .bind(email)
        .fetch_one(tx.as_mut())
        .await?;

    Ok(user)
}
