const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return {
        statusCode: 405,
        body: JSON.stringify({
          message: "Method not allowed"
        })
      };
    }

    const result = await pool.query(
      `SELECT
        id,
        name,
        minimum_amount,
        maximum_amount,
        daily_rate,
        duration_days
       FROM investment_plans
       WHERE is_active = TRUE
       ORDER BY minimum_amount ASC`
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify(result.rows)
    };

  } catch (error) {
    console.error("Investment plans error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Unable to load investment plans"
      })
    };
  }
};