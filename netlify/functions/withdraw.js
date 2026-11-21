
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
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify(body)
    };
}

function normalizePhone(phone) {
    phone = String(phone || "").replace(/\s+/g, "");

    if (phone.startsWith("+254")) {
        return phone.substring(1);
    }

    if (phone.startsWith("0")) {
        return "254" + phone.substring(1);
    }

    return phone;
}

exports.handler = async (event) => {

    if (event.httpMethod === "OPTIONS") {
        return response(200, { message: "OK" });
    }

    if (event.httpMethod !== "POST") {
        return response(405, {
            message: "Method not allowed."
        });
    }

    let client;
    let transactionStarted = false;

    try {

        // AUTHENTICATION
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
                message: "Invalid authentication token."
            });
        }

        // INPUT
        const body = JSON.parse(event.body || "{}");

        const amount = Number(body.amount);
        const phone = normalizePhone(body.phone);

        if (!Number.isInteger(amount) || amount < 1) {
            return response(400, {
                message: "Enter a valid withdrawal amount."
            });
        }

        if (!/^254[17]\d{8}$/.test(phone)) {
            return response(400, {
                message: "Enter a valid Kenyan M-Pesa number."
            });
        }

        client = await pool.connect();

        await client.query("BEGIN");
        transactionStarted = true;

        // LOCK WALLET TO PREVENT SIMULTANEOUS WITHDRAWALS
        const walletResult = await client.query(
            `SELECT balance
             FROM wallets
             WHERE user_id = $1
             FOR UPDATE`,
            [userId]
        );

        if (walletResult.rows.length === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return response(404, {
                message: "Wallet not found."
            });
        }

        const balance = Number(walletResult.rows[0].balance);

        if (amount > balance) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return response(400, {
                message: "Insufficient wallet balance."
            });
        }

        // CHECK USER STATUS
        const userResult = await client.query(
            `SELECT id, status
             FROM users
             WHERE id = $1`,
            [userId]
        );

        if (
            userResult.rows.length === 0 ||
            userResult.rows[0].status !== "active"
        ) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return response(403, {
                message: "Your account is not active."
            });
        }

        // CHECK PLATFORM WITHDRAWAL SETTINGS
        const settingsResult = await client.query(
            `SELECT withdrawals_enabled
             FROM platform_settings
             LIMIT 1`
        );

        if (
            settingsResult.rows.length > 0 &&
            settingsResult.rows[0].withdrawals_enabled === false
        ) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return response(403, {
                message: "Withdrawals are currently disabled."
            });
        }

        // CREATE REFERENCE
        const reference =
            "GW" +
            Date.now().toString() +
            Math.floor(Math.random() * 1000)
                .toString()
                .padStart(3, "0");

        // DEDUCT AMOUNT AS RESERVED FUNDS
        await client.query(
            `UPDATE wallets
             SET balance = balance - $1
             WHERE user_id = $2`,
            [amount, userId]
        );

        // CREATE WITHDRAWAL REQUEST
        await client.query(
            `INSERT INTO withdrawals
             (user_id, amount, phone, reference, status)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                userId,
                amount,
                phone,
                reference,
                "pending"
            ]
        );

        // RECORD TRANSACTION
        await client.query(
            `INSERT INTO transactions
             (user_id, transaction_type, amount,
              reference, description, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                userId,
                "withdrawal",
                amount,
                reference,
                "Withdrawal request submitted",
                "pending"
            ]
        );

        await client.query("COMMIT");
        transactionStarted = false;

        return response(200, {
            success: true,
            message:
                "Withdrawal request submitted successfully. It is pending approval.",
            reference: reference,
            amount: amount,
            phone: phone,
            status: "pending"
        });

    } catch (error) {

        if (client && transactionStarted) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error(
                    "Withdrawal rollback error:",
                    rollbackError.message
                );
            }
        }

        console.error("Withdrawal error:", error.message);

        return response(500, {
            message: "Unable to submit withdrawal request."
        });

    } finally {

        if (client) {
            client.release();
        }

    }
};
