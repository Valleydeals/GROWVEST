const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

function response(statusCode, body) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    };
}

exports.handler = async (event) => {

    if (event.httpMethod !== "POST") {
        return response(405, {
            message: "Method not allowed"
        });
    }

    let client;

    try {

        // Authenticate user
        const authHeader =
            event.headers.authorization ||
            event.headers.Authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return response(401, {
                message: "Authentication required."
            });
        }

        const token = authHeader.split(" ")[1];

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        const userId = decoded.id || decoded.userId;

        if (!userId) {
            return response(401, {
                message: "Invalid token."
            });
        }

        const body = JSON.parse(event.body || "{}");
        const reference = String(body.reference || "").trim();

        if (!reference) {
            return response(400, {
                message: "Deposit reference is required."
            });
        }

        if (!process.env.MAKAMESCO_API_KEY) {
            return response(500, {
                message: "Payment configuration missing."
            });
        }

        client = await pool.connect();

        // Find only this user's deposit
        const depositResult = await client.query(
            `SELECT *
             FROM deposits
             WHERE payment_reference = $1
               AND user_id = $2`,
            [reference, userId]
        );

        if (depositResult.rows.length === 0) {
            return response(404, {
                message: "Deposit not found."
            });
        }

        const deposit = depositResult.rows[0];

        // Already credited: prevent duplicate credit
        if (deposit.status === "completed") {
            return response(200, {
                success: true,
                status: "completed",
                message: "Payment already confirmed.",
                reference
            });
        }

        if (!deposit.provider_reference) {
            return response(400, {
                message: "Payment request reference is missing."
            });
        }

        // Check status with Makamesco
        const statusUrl =
            "https://makamescopay.com/api/payments/status/" +
            encodeURIComponent(deposit.provider_reference);

        const statusResponse = await fetch(statusUrl, {
            method: "GET",
            headers: {
                "X-API-Key": process.env.MAKAMESCO_API_KEY
            }
        });

        const paymentStatusData = await statusResponse.json();

        if (!statusResponse.ok) {
            console.error(
                "Makamesco status error:",
                paymentStatusData
            );

            return response(502, {
                message: "Unable to verify payment status."
            });
        }

        const paymentStatus =
            String(
                paymentStatusData.status ||
                paymentStatusData.data?.status ||
                ""
            ).toLowerCase();

        // Pending
        if (paymentStatus === "pending") {
            return response(200, {
                success: true,
                status: "pending",
                message: "Waiting for M-Pesa payment."
            });
        }

        // Failed
        if (paymentStatus === "failed") {

            await client.query(
                `UPDATE deposits
                 SET status = 'failed'
                 WHERE payment_reference = $1
                   AND status = 'pending'`,
                [reference]
            );

            return response(200, {
                success: true,
                status: "failed",
                message: "Payment failed."
            });
        }

        // Cancelled
        if (paymentStatus === "cancelled") {

            await client.query(
                `UPDATE deposits
                 SET status = 'cancelled'
                 WHERE payment_reference = $1
                   AND status = 'pending'`,
                [reference]
            );

            return response(200, {
                success: true,
                status: "cancelled",
                message: "Payment was cancelled."
            });
        }

        // Only completed payments can credit wallets
        if (paymentStatus !== "completed") {
            return response(200, {
                success: true,
                status: "pending",
                message: "Payment is still being processed."
            });
        }

        // Verify amount returned by provider
        const confirmedAmount = Number(
            paymentStatusData.amount ??
            paymentStatusData.data?.amount
        );

        if (
            !Number.isFinite(confirmedAmount) ||
            confirmedAmount !== Number(deposit.amount)
        ) {
            console.error("Deposit amount mismatch", {
                reference,
                expected: deposit.amount,
                received: confirmedAmount
            });

            return response(400, {
                message: "Payment amount verification failed."
            });
        }

        // CREDIT WALLET TRANSACTIONALLY
        await client.query("BEGIN");

        const lockedDeposit = await client.query(
            `SELECT *
             FROM deposits
             WHERE payment_reference = $1
               AND user_id = $2
             FOR UPDATE`,
            [reference, userId]
        );

        if (lockedDeposit.rows.length === 0) {
            await client.query("ROLLBACK");

            return response(404, {
                message: "Deposit not found."
            });
        }

        const currentDeposit = lockedDeposit.rows[0];

        // Protect against duplicate payment checks
        if (currentDeposit.status === "completed") {
            await client.query("COMMIT");

            return response(200, {
                success: true,
                status: "completed",
                message: "Payment already credited.",
                reference
            });
        }

        if (currentDeposit.status !== "pending") {
            await client.query("ROLLBACK");

            return response(200, {
                success: true,
                status: currentDeposit.status,
                message: "Deposit is no longer pending."
            });
        }

        // Mark deposit completed
        await client.query(
            `UPDATE deposits
             SET status = 'completed'
             WHERE payment_reference = $1`,
            [reference]
        );

        // Add funds to wallet
        await client.query(
            `UPDATE wallets
             SET balance = balance + $1
             WHERE user_id = $2`,
            [
                deposit.amount,
                userId
            ]
        );

        // Record ledger transaction
        await client.query(
            `INSERT INTO transactions
             (user_id, transaction_type, amount,
              reference, description, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                userId,
                "deposit",
                deposit.amount,
                reference,
                "Confirmed M-Pesa deposit",
                "completed"
            ]
        );

        await client.query("COMMIT");

        return response(200, {
            success: true,
            status: "completed",
            message: "Payment confirmed and wallet credited.",
            amount: deposit.amount,
            reference,
            receipt:
                paymentStatusData.mpesaReceiptNumber ||
                paymentStatusData.data?.mpesaReceiptNumber ||
                null
        });

    } catch (error) {

        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (_) {}
        }

        console.error("Payment verification error:", error);

        return response(500, {
            message: "Unable to verify payment."
        });

    } finally {

        if (client) {
            client.release();
        }

    }
};