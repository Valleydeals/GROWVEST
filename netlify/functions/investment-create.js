const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
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

    const userId =
      decoded.userId ||
      decoded.user_id ||
      decoded.id;

    if (!userId) {
      return {
        statusCode: 401,
        body: JSON.stringify({ message: "Invalid user token" })
      };
    }

    const body = JSON.parse(event.body || "{}");

    const planId = body.planId;
    const amount = Number(body.amount);

    if (
      !planId ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isInteger(amount * 100)
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Invalid plan or investment amount"
        })
      };
    }

    client = await pool.connect();

    await client.query("BEGIN");

    // Check platform investment switch
    const settingsResult = await client.query(
      `SELECT investments_enabled
       FROM platform_settings
       LIMIT 1`
    );

    if (
      !settingsResult.rows.length ||
      settingsResult.rows[0].investments_enabled !== true
    ) {
      await client.query("ROLLBACK");

      return {
        statusCode: 403,
        body: JSON.stringify({
          message: "Investments are currently disabled"
        })
      };
    }

    // Fetch active plan
    const planResult = await client.query(
      `SELECT *
       FROM investment_plans
       WHERE id = $1
         AND is_active = TRUE
       FOR SHARE`,
      [planId]
    );

    if (!planResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        statusCode: 404,
        body: JSON.stringify({
          message: "Investment plan not found or inactive"
        })
      };
    }

    const plan = planResult.rows[0];

    const minimum = Number(plan.minimum_amount);
    const maximum = Number(plan.maximum_amount);
    const dailyRate = Number(plan.daily_rate);

    // Validate plan amount limits
    if (amount < minimum || amount > maximum) {
      await client.query("ROLLBACK");

      return {
        statusCode: 400,
        body: JSON.stringify({
          message: `Amount must be between KSh ${minimum} and KSh ${maximum}`
        })
      };
    }

    // Only zero-rate test plans are permitted for now.
    // No automated profit generation is implemented.
    if (dailyRate !== 0) {
      await client.query("ROLLBACK");

      return {
        statusCode: 403,
        body: JSON.stringify({
          message: "This plan is not available for testing"
        })
      };
    }

    // Lock wallet to prevent concurrent spending
    const walletResult = await client.query(
      `SELECT balance
       FROM wallets
       WHERE user_id = $1
       FOR UPDATE`,
      [userId]
    );

    if (!walletResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        statusCode: 404,
        body: JSON.stringify({
          message: "Wallet not found"
        })
      };
    }

    const balance = Number(walletResult.rows[0].balance);

    if (balance < amount) {
      await client.query("ROLLBACK");

      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Insufficient wallet balance"
        })
      };
    }

    // Deduct funds
    await client.query(
      `UPDATE wallets
       SET balance = balance - $1,
           updated_at = NOW()
       WHERE user_id = $2`,
      [amount, userId]
    );

    // Create investment
    const investmentResult = await client.query(
      `INSERT INTO investments
       (
         user_id,
         plan_id,
         amount,
         daily_rate,
         status,
         start_date,
         end_date
       )
       VALUES
       (
         $1,
         $2,
         $3,
         $4,
         'active',
         NOW(),
         NOW() + ($5 * INTERVAL '1 day')
       )
       RETURNING *`,
      [
        userId,
        plan.id,
        amount,
        dailyRate,
        plan.duration_days
      ]
    );

    const investment = investmentResult.rows[0];

    const reference =
      "INV-" +
      Date.now() +
      "-" +
      crypto.randomBytes(3).toString("hex").toUpperCase();

    // Record transaction
    await client.query(
      `INSERT INTO transactions
       (
         user_id,
         transaction_type,
         amount,
         reference,
         description,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        "investment",
        amount,
        reference,
        `Investment in ${plan.name} plan`,
        "completed"
      ]
    );

    await client.query("COMMIT");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        success: true,
        message: "Investment created successfully",
        investmentId: investment.id,
        reference,
        amount,
        plan: plan.name,
        newBalance: balance - amount
      })
    };

  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }

    console.error("Investment creation error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: "Unable to create investment"
      })
    };

  } finally {
    if (client) {
      client.release();
    }
  }
};