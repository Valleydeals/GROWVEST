
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
        phone = phone.substring(1);
    } else if (phone.startsWith("0")) {
        phone = "254" + phone.substring(1);
    }

    return phone;
}

exports.handler = async (event) => {

    if (event.httpMethod === "OPTIONS") {
        return response(200, { message: "OK" });
    }

    if (event.httpMethod !== "POST") {
        return response(405, {
            message: "Method not allowed"
        });
    }

    let client;

    try {

        // AUTHENTICATION
        const authHeader = event.headers.authorization ||
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
                message: "Enter a valid deposit amount."
            });
        }

        if (!/^254[17]\d{8}$/.test(phone)) {
            return response(400, {
                message: "Enter a valid Kenyan phone number."
            });
        }

        if (!process.env.MAKAMESCO_API_KEY) {
            return response(500, {
                message: "Payment configuration is missing."
            });
        }

        client = await pool.connect();

        // VERIFY USER
        const userResult = await client.query(
            `SELECT id, status
             FROM users
             WHERE id = $1`,
            [userId]
        );

        if (userResult.rows.length === 0) {
            return response(404, {
                message: "User not found."
            });
        }

        if (userResult.rows[0].status !== "active") {
            return response(403, {
                message: "Your account is not active."
            });
        }

        // CREATE UNIQUE REFERENCE
        const reference =
            "GV" + Date.now().toString().slice(-10);

        // SAVE PENDING DEPOSIT
        await client.query(
            `INSERT INTO deposits
             (user_id, amount, phone, payment_reference, status)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                userId,
                amount,
                phone,
                reference,
                "pending"
            ]
        );

        // INITIATE MAKAMESCO STK PUSH
        const makamescoResponse = await fetch(
            "https://makamescopay.com/api/payments/stkpush",
            {
                method: "POST",
                headers: {
                    "X-API-Key": process.env.MAKAMESCO_API_KEY,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    phoneNumber: phone,
                    amount: amount,
                    accountReference: reference,
                    transactionDesc: "GrowVest Deposit"
                })
            }
        );

        const paymentData = await makamescoResponse.json();

        if (!makamescoResponse.ok) {

            await client.query(
                `UPDATE deposits
                 SET status = 'failed'
                 WHERE payment_reference = $1`,
                [reference]
            );

            return response(400, {
                message: paymentData.message ||
                         "Unable to initiate M-Pesa payment."
                });
        }

        // STORE PROVIDER REFERENCE IF RETURNED
        const providerReference =
            paymentData.checkout_id ||
            paymentData.checkoutRequestId ||
            paymentData.transaction_id ||
            paymentData.reference ||
            paymentData.id ||
            paymentData.data?.checkout_id ||
            paymentData.data?.transaction_id ||
            null;

        await client.query(
            `UPDATE deposits
             SET provider_reference = $1
             WHERE payment_reference = $2`,
            [
                providerReference,
                reference
            ]
        );

        return response(200, {
            success: true,
            message: paymentData.message ||
                     "STK Push initiated. Check your phone and complete payment.",
            reference: reference,
            providerReference: providerReference,
            status: "pending"
        });

    } catch (error) {

        console.error("Deposit error:", error.message);

        return response(500, {
            message: "Unable to process deposit request."
        });

    } finally {

        if (client) {
            client.release();
        }

    }
};
