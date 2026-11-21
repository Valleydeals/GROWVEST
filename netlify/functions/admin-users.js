const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      body: JSON.stringify({ message: "Method not allowed" })
    };
  }

  let client;

  try {
    const authHeader = event.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return {
        statusCode: 401,
        body: JSON.stringify({ message: "Unauthorized" })
      };
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== "admin") {
      return {
        statusCode: 403,
        body: JSON.stringify({ message: "Admin access required" })
      };
    }

    const search = (event.queryStringParameters?.search || "").trim();

    client = await pool.connect();

    const result = await client.query(
      `
      SELECT
        u.id,
        u.full_name,
        u.phone,
        u.email,
        u.status,
        u.referral_code,
        u.created_at,
        COALESCE(w.balance, 0) AS wallet_balance
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      WHERE
        $1 = ''
        OR u.full_name ILIKE $2
        OR u.phone ILIKE $2
        OR COALESCE(u.email, '') ILIKE $2
        OR u.referral_code ILIKE $2
      ORDER BY u.created_at DESC
      LIMIT 200
      `,
      [search, `%${search}%`]
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        success: true,
        users: result.rows
      })
    };

  } catch (error) {
    console.error("Admin users error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: "Unable to retrieve users"
      })
    };

  } finally {
    if (client) client.release();
  }
};
