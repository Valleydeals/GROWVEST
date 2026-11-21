
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

    const body = JSON.parse(event.body || "{}");
    const withdrawalId = body.withdrawalId;
    const action = body.action;

    if (!withdrawalId || !["approve", "reject"].includes(action)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Invalid withdrawal ID or action"
        })
      };
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const withdrawalResult = await client.query(
      `SELECT *
       FROM withdrawals
       WHERE id = $1
       FOR UPDATE`,
      [withdrawalId]
    );

    if (!withdrawalResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Withdrawal not found" })
      };
    }

    const withdrawal = withdrawalResult.rows[0];

    if (withdrawal.status !== "pending") {
      await client.query("ROLLBACK");

      return {
        statusCode: 409,
        body: JSON.stringify({
          message: "This withdrawal has already been processed"
        })
      };
    }

    if (action === "approve") {
      await client.query(
        `UPDATE withdrawals
         SET status = 'processing'
         WHERE id = $1`,
        [withdrawalId]
      );

      await client.query(
        `UPDATE transactions
         SET status = 'processing'
         WHERE reference = $1`,
        [withdrawal.reference]
      );

      await client.query("COMMIT");

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: "Withdrawal approved and marked processing"
        })
      };
    }

    // REJECTION: refund reserved wallet amount
    await client.query(
      `UPDATE wallets
       SET balance = balance + $1
       WHERE user_id = $2`,
      [withdrawal.amount, withdrawal.user_id]
    );

    await client.query(
      `UPDATE withdrawals
       SET status = 'rejected'
       WHERE id = $1`,
      [withdrawalId]
    );

    await client.query(
      `UPDATE transactions
       SET status = 'rejected'
       WHERE reference = $1`,
      [withdrawal.reference]
    );

    await client.query(
      `INSERT INTO transactions
       (user_id, transaction_type, amount, reference, description, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        withdrawal.user_id,
        "withdrawal_refund",
        withdrawal.amount,
        "REF-" + withdrawal.reference,
        "Refund for rejected withdrawal",
        "completed"
      ]
    );

    await client.query("COMMIT");

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Withdrawal rejected and funds refunded"
      })
    };

  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }

    console.error("Withdrawal action error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: "Unable to process withdrawal action"
      })
    };

  } finally {
    if (client) client.release();
  }
};
