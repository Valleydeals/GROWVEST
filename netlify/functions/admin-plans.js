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

    const decoded = jwt.verify(
      authHeader.split(" ")[1],
      process.env.JWT_SECRET
    );

    if (decoded.role !== "admin") {
      return {
        statusCode: 403,
        body: JSON.stringify({ message: "Admin access required" })
      };
    }

    client = await pool.connect();

    const result = await client.query(`
      SELECT
        id,
        name,
        minimum_amount AS min_amount,
        maximum_amount AS max_amount,
        daily_rate,
        duration_days,
        is_active
      FROM investment_plans
      ORDER BY id ASC
    `);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        success: true,
        plans: result.rows
      })
    };

  } catch (error) {
    console.error("Admin plans error:", error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        success: false,
        message: error.message || "Unable to retrieve investment plans"
      })
    };

  } finally {
    if (client) client.release();
  }
};