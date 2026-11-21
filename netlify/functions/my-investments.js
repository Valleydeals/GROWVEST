
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

        // Authenticate user
        const authHeader =
            event.headers.authorization ||
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

        // Fetch investments belonging to this user
        const result = await pool.query(
            `
            SELECT
                i.id,
                i.amount,
                i.daily_rate,
                i.status,
                i.start_date,
                i.end_date,
                i.created_at,
                p.name AS plan_name,
                p.duration_days
            FROM investments i
            LEFT JOIN investment_plans p
                ON p.id = i.plan_id
            WHERE i.user_id = $1
            ORDER BY i.created_at DESC
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
                investments: result.rows
            })
        };

    } catch (error) {

        console.error("My Investments API error:", error);

        if (
            error.name === "JsonWebTokenError" ||
            error.name === "TokenExpiredError"
        ) {
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
                message: "Failed to load investments"
            })
        };
    }
};
