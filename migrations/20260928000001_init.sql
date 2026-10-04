-- miki-payment initial schema.
-- Money amounts are stored as BIGINT in minor units (cents, satoshis).
-- Status columns are VARCHAR + CHECK rather than ENUM so they can be extended
-- with a normal migration later.

CREATE TABLE users (
    id          BIGINT NOT NULL AUTO_INCREMENT,
    email       VARCHAR(255)    NOT NULL,
    name        VARCHAR(255)    NULL,
    created_at  DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at  DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE orders (
    id            BIGINT NOT NULL AUTO_INCREMENT,
    order_number  VARCHAR(40)     NOT NULL,
    user_id       BIGINT NOT NULL,
    amount        BIGINT          NOT NULL,
    currency      CHAR(3)         NOT NULL,
    description   VARCHAR(255)    NULL,
    status        VARCHAR(16)     NOT NULL DEFAULT 'pending',
    created_at    DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at    DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                  ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_orders_order_number (order_number),
    KEY idx_orders_user_id (user_id),
    CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT chk_orders_amount   CHECK (amount > 0),
    CONSTRAINT chk_orders_currency CHECK (currency = UPPER(currency)),
    CONSTRAINT chk_orders_status   CHECK (
        status IN ('pending', 'processing', 'paid', 'expired', 'cancelled')
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE invoices (
    id                BIGINT NOT NULL AUTO_INCREMENT,
    order_id          BIGINT NOT NULL,
    invoice_number    VARCHAR(40)     NOT NULL,
    amount            BIGINT          NOT NULL,
    currency          CHAR(3)         NOT NULL,
    status            VARCHAR(16)     NOT NULL DEFAULT 'pending',
    -- Reserved for the BTCPay Server integration. Null until then.
    btcpay_invoice_id VARCHAR(64)     NULL,
    payment_url       VARCHAR(512)    NULL,
    expires_at        DATETIME(6)     NULL,
    paid_at           DATETIME(6)     NULL,
    created_at        DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at        DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                      ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_invoices_invoice_number (invoice_number),
    UNIQUE KEY uq_invoices_btcpay_id (btcpay_invoice_id),
    KEY idx_invoices_order_id (order_id),
    CONSTRAINT fk_invoices_order FOREIGN KEY (order_id) REFERENCES orders (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT chk_invoices_amount CHECK (amount > 0),
    CONSTRAINT chk_invoices_status CHECK (
        status IN ('pending', 'processing', 'paid', 'expired', 'cancelled')
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payments (
    id             BIGINT NOT NULL AUTO_INCREMENT,
    invoice_id     BIGINT NOT NULL,
    order_id       BIGINT NOT NULL,
    method         VARCHAR(32)     NOT NULL DEFAULT 'bitcoin',
    status         VARCHAR(16)     NOT NULL DEFAULT 'pending',
    amount         BIGINT          NULL,
    currency       CHAR(3)         NULL,
    confirmations  INT             NOT NULL DEFAULT 0,
    -- Reserved for the BTCPay Server integration. Null until then.
    txid           VARCHAR(128)    NULL,
    external_id    VARCHAR(64)     NULL,
    created_at     DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at     DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                   ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_payments_external_id (external_id),
    KEY idx_payments_invoice_id (invoice_id),
    KEY idx_payments_order_id (order_id),
    CONSTRAINT fk_payments_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT chk_payments_status CHECK (
        status IN ('pending', 'processing', 'confirmed', 'failed', 'underpaid', 'overpaid')
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only ledger. payment_id / order_id are nullable so fee and
-- adjustment rows can be recorded without a payment.
CREATE TABLE transactions (
    id           BIGINT NOT NULL AUTO_INCREMENT,
    payment_id   BIGINT NULL,
    order_id     BIGINT NULL,
    txn_type     VARCHAR(16)     NOT NULL,
    amount       BIGINT          NOT NULL,
    currency     CHAR(3)         NOT NULL,
    reference    VARCHAR(64)     NULL,
    created_at   DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    KEY idx_transactions_payment_id (payment_id),
    KEY idx_transactions_order_id (order_id),
    CONSTRAINT fk_transactions_payment FOREIGN KEY (payment_id) REFERENCES payments (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_transactions_order FOREIGN KEY (order_id) REFERENCES orders (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT chk_transactions_amount CHECK (amount <> 0),
    CONSTRAINT chk_transactions_type CHECK (
        txn_type IN ('payment', 'refund', 'fee', 'adjustment')
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
