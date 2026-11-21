const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
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

  if (event.httpMethod !== "GET") {
    return response(405, {
      message: "Method not allowed"
    });
  }

  try {
    const authHeader =
      event.headers.authorization ||
      event.headers.Authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return response(401, {
        message: "Authentication required."
      });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    const userId = decoded.userId;

    // User information and wallet
    const userResult = await pool.query(
      `SELECT
         u.id,
         u.full_name,
         u.phone,
         u.email,
         u.referral_code,
         u.created_at,
         COALESCE(w.balance, 0) AS balance
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return response(404, {
        message: "User not found."
      });
    }

    // Completed deposits
    const depositsResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM deposits
       WHERE user_id = $1
       AND status = 'completed'`,
      [userId]
    );

    // Completed withdrawals
    const withdrawalsResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM withdrawals
       WHERE user_id = $1
       AND status = 'completed'`,
      [userId]
    );

    // Active investments
    const investmentsResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM investments
       WHERE user_id = $1
       AND status = 'active'`,
      [userId]
    );

    // Referral rewards
    const referralsResult = await pool.query(
      `SELECT COALESCE(SUM(bonus_amount), 0) AS total
       FROM referrals
       WHERE referrer_id = $1
       AND status = 'completed'`,
      [userId]
    );

    // Referral count
    const referralCountResult = await pool.query(
      `SELECT COUNT(*) AS total
       FROM referrals
       WHERE referrer_id = $1`,
      [userId]
    );

    // Recent transactions
    const transactionsResult = await pool.query(
      `SELECT
         transaction_type,
         amount,
         reference,
         description,
         status,
         created_at
       FROM transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId]
    );

    return response(200, {
      user: userResult.rows[0],

      statistics: {
        totalDeposits: Number(depositsResult.rows[0].total),
        totalWithdrawals: Number(withdrawalsResult.rows[0].total),
        activeInvestments: Number(investmentsResult.rows[0].total),
        referralRewards: Number(referralsResult.rows[0].total),
        referralCount: Number(referralCountResult.rows[0].total)
      },

      transactions: transactionsResult.rows
    });

  } catch (error) {
    console.error("Profile error:", error);

    if (error.name === "JsonWebTokenError" ||
        error.name === "TokenExpiredError") {
      return response(401, {
        message: "Your session has expired. Please login again."
      });
    }

    return response(500, {
      message: "Unable to load account information."
    });
  }
};