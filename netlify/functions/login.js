const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function response(statusCode, data) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(data)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(200, {});
  }

  if (event.httpMethod !== "POST") {
    return response(405, {
      message: "Method not allowed"
    });
  }

  try {
    const { identifier, password } =
      JSON.parse(event.body || "{}");

    if (!identifier || !password) {
      return response(400, {
        message: "Enter your phone/email and password."
      });
    }

    const cleanIdentifier = identifier.trim();

    const result = await pool.query(
      `SELECT *
       FROM users
       WHERE phone = $1
          OR email = LOWER($1)
       LIMIT 1`,
      [cleanIdentifier]
    );

    if (result.rows.length === 0) {
      return response(401, {
        message: "Invalid login credentials."
      });
    }

    const user = result.rows[0];

    const passwordMatch = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatch) {
      return response(401, {
        message: "Invalid login credentials."
      });
    }

    if (user.status !== "active") {
      return response(403, {
        message: "Your account is currently unavailable."
      });
    }

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return response(200, {
      message: "Login successful.",
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        phone: user.phone,
        email: user.email,
        referral_code: user.referral_code
      }
    });

  } catch (error) {
    console.error("Login error:", error);

    return response(500, {
      message: "Login failed. Please try again."
    });
  }
};