
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

    const client = await pool.connect();

    try {
      const usersResult = await client.query(`
        SELECT COUNT(*) AS total_users
        FROM users
      `);

      const depositsResult = await client.query(`
        SELECT
          COALESCE(SUM(amount), 0) AS total_deposits
        FROM deposits
        WHERE status = 'completed'
      `);

      const withdrawalsResult = await client.query(`
        SELECT COUNT(*) AS pending_withdrawals
        FROM withdrawals
        WHERE status = 'pending'
      `);

      const investmentsResult = await client.query(`
        SELECT
          COALESCE(SUM(amount), 0) AS active_investments
        FROM investments
        WHERE status = 'active'
      `);

      const transactionsResult = await client.query(`
        SELECT
          t.id,
          t.user_id,
          t.transaction_type,
          t.amount,
          t.reference,
          t.description,
          t.status,
          t.created_at,
          u.full_name,
          u.phone
        FROM transactions t
        LEFT JOIN users u ON u.id = t.user_id
        ORDER BY t.created_at DESC
        LIMIT 10
      `);

      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({
          success: true,
          stats: {
            totalUsers: Number(usersResult.rows[0].total_users),
            totalDeposits: Number(depositsResult.rows[0].total_deposits),
            pendingWithdrawals: Number(
              withdrawalsResult.rows[0].pending_withdrawals
            ),
            activeInvestments: Number(
              investmentsResult.rows[0].active_investments
            )
          },
          transactions: transactionsResult.rows
        })
      };

    } finally {
      client.release();
    }

  } catch (error) {
    console.error("Admin statistics error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: "Unable to load admin statistics"
      })
    };
  }
};
