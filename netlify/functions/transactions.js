
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

exports.handler = async (event) => {
    if (event.httpMethod !== "GET") {
        return {
            statusCode: 405,
            body: JSON.stringify({
                success: false,
                message: "Method not allowed"
            })
        };
    }

    try {
        // Get authorization token
        const authHeader = event.headers.authorization ||
                          event.headers.Authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return {
                statusCode: 401,
                body: JSON.stringify({
                    success: false,
                    message: "Authentication required"
                })
            };
        }

        const token = authHeader.split(" ")[1];

        // Verify JWT
        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        const userId =
            decoded.userId ||
            decoded.user_id ||
            decoded.id;

        if (!userId) {
            return {
                statusCode: 401,
                body: JSON.stringify({
                    success: false,
                    message: "Invalid authentication token"
                })
            };
        }

        // Fetch only this user's transactions
        const result = await pool.query(
            `
            SELECT
                id,
                transaction_type,
                amount,
                reference,
                description,
                status,
                created_at
            FROM transactions
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 100
            `,
            [userId]
        );

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                success: true,
                transactions: result.rows
            })
        };

    } catch (error) {
        console.error("Transactions API error:", error);

        if (error.name === "JsonWebTokenError" ||
            error.name === "TokenExpiredError") {
            return {
                statusCode: 401,
                body: JSON.stringify({
                    success: false,
                    message: "Invalid or expired token"
                })
            };
        }

        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                message: "Failed to load transactions"
            })
        };
    }
};
