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
      body: JSON.stringify({ success: false, message: "Method not allowed" })
    };
  }

  try {
    // Verify admin token
    const authHeader = event.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return {
        statusCode: 401,
        body: JSON.stringify({ success: false, message: "Unauthorized" })
      };
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== "admin") {
      return {
        statusCode: 403,
        body: JSON.stringify({ success: false, message: "Admin access required" })
      };
    }

    // Fetch all investments
    const result = await pool.query(`
      SELECT
        i.id,
        i.amount,
        i.daily_rate,
        i.status,
        i.start_date,
        i.end_date,
        i.created_at,
        u.full_name,
        u.phone,
        p.name AS plan_name,
        p.duration_days
      FROM investments i
      LEFT JOIN users u ON i.user_id = u.id
      LEFT JOIN investment_plans p ON i.plan_id = p.id
      ORDER BY i.created_at DESC
    `);

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
    console.error("Admin investments error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: "Failed to load investments"
      })
    };
  }
};