
const jwt = require("jsonwebtoken");

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
            message: "Method not allowed."
        });
    }

    try {

        const body = JSON.parse(event.body || "{}");

        const username = String(body.username || "").trim();
        const password = String(body.password || "");

        if (!username || !password) {
            return response(400, {
                message: "Enter username and password."
            });
        }

        const adminUsername = process.env.ADMIN_USERNAME;
        const adminPassword = process.env.ADMIN_PASSWORD;
        const jwtSecret = process.env.JWT_SECRET;

        if (!adminUsername || !adminPassword || !jwtSecret) {
            console.error("Admin login environment variables missing.");

            return response(500, {
                message: "Admin login configuration error."
            });
        }

        if (
            username !== adminUsername ||
            password !== adminPassword
        ) {
            return response(401, {
                message: "Invalid admin username or password."
            });
        }

        const token = jwt.sign(
            {
                username: adminUsername,
                role: "admin"
            },
            jwtSecret,
            {
                expiresIn: "8h"
            }
        );

        return response(200, {
            success: true,
            message: "Admin login successful.",
            token: token
        });

    } catch (error) {

        console.error("Admin login error:", error.message);

        return response(500, {
            message: "Unable to login."
        });

    }
};
