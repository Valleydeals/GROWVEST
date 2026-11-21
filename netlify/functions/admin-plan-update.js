const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ success: false, message: "Method not allowed" })
    };
  }

  try {
    const authHeader = event.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");

    if (!token) {
      return {
        statusCode: 401,
        body: JSON.stringify({ success: false, message: "Unauthorized" })
      };
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== "admin") {
      return {
        statusCode: 403,
        body: JSON.stringify({ success: false, message: "Admin access required" })
      };
    }

    const {
      planId,
      minimum_amount,
      maximum_amount,
      daily_rate,
      duration_days
    } = JSON.parse(event.body || "{}");

    if (!planId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, message: "Plan ID is required" })
      };
    }

    const min = Number(minimum_amount);
    const max = Number(maximum_amount);
    const rate = Number(daily_rate);
    const duration = Number(duration_days);

    if (
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      !Number.isFinite(rate) ||
      !Number.isFinite(duration) ||
      min <= 0 ||
      max < min ||
      rate < 0 ||
      duration < 1
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          success: false,
          message: "Please enter valid plan settings."
        })
      };
    }

    // Current testing mode: non-zero earnings rates are not enabled.
   

    const result = await pool.query(
      `UPDATE investment_plans
       SET minimum_amount = $1,
           maximum_amount = $2,
           daily_rate = $3,
           duration_days = $4
       WHERE id = $5
       RETURNING id, name, minimum_amount, maximum_amount,
                 daily_rate, duration_days, is_active`,
      [min, max, rate, duration, planId]
    );

    if (result.rows.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ success: false, message: "Plan not found" })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Investment plan updated successfully.",
        plan: result.rows[0]
      })
    };

  } catch (error) {
    console.error("Admin plan update error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: "Server error updating investment plan."
      })
    };
  }
};