const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

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

function generateReferralCode() {
  return "GV" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(200, {});
  }

  if (event.httpMethod !== "POST") {
    return response(405, { message: "Method not allowed" });
  }

  let client;

  try {
    const {
      fullName,
      phone,
      email,
      password,
      referralCode
    } = JSON.parse(event.body || "{}");

    if (!fullName || !phone || !password) {
      return response(400, {
        message: "Full name, phone and password are required."
      });
    }

    if (fullName.trim().length < 2) {
      return response(400, {
        message: "Please enter a valid full name."
      });
    }

    if (password.length < 8) {
      return response(400, {
        message: "Password must be at least 8 characters."
      });
    }

    let cleanPhone = phone.replace(/\s+/g, "");

if (cleanPhone.startsWith("+254")) {
  // Already international format
} else if (cleanPhone.startsWith("254")) {
  cleanPhone = "+" + cleanPhone;
} else if (
  cleanPhone.length === 9 &&
  /^[17]/.test(cleanPhone)
) {
  cleanPhone = "+254" + cleanPhone;
} else if (cleanPhone.startsWith("0")) {
  cleanPhone = "+254" + cleanPhone.substring(1);
}
    const cleanEmail = email
      ? email.trim().toLowerCase()
      : null;

    if (
      cleanEmail &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    ) {
      return response(400, {
        message: "Enter a valid email address."
      });
    }

    client = await pool.connect();

    await client.query("BEGIN");

    // Check existing account
    const existing = await client.query(
      `SELECT id FROM users
       WHERE phone = $1 OR
       ($2 IS NOT NULL AND email = $2)`,
      [cleanPhone, cleanEmail]
    );

    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");

      return response(409, {
        message: "An account with this phone number or email already exists."
      });
    }

    // Validate referral code
    let referrerId = null;

    if (referralCode && referralCode.trim()) {
      const referral = await client.query(
        `SELECT id FROM users
         WHERE referral_code = $1`,
        [referralCode.trim().toUpperCase()]
      );

      if (referral.rows.length === 0) {
        await client.query("ROLLBACK");

        return response(400, {
          message: "Invalid referral code."
        });
      }

      referrerId = referral.rows[0].id;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const newReferralCode = generateReferralCode();

    const userResult = await client.query(
      `INSERT INTO users
       (full_name, phone, email, password_hash,
        referral_code, referred_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, full_name, phone, email, referral_code`,
      [
        fullName.trim(),
        cleanPhone,
        cleanEmail,
        passwordHash,
        newReferralCode,
        referrerId
      ]
    );

    const user = userResult.rows[0];

    // Create wallet
    await client.query(
      `INSERT INTO wallets (user_id, balance)
       VALUES ($1, 0)`,
      [user.id]
    );

    // Record referral
    if (referrerId) {
      await client.query(
        `INSERT INTO referrals
         (referrer_id, referred_user_id)
         VALUES ($1, $2)`,
        [referrerId, user.id]
      );
    }

    await client.query("COMMIT");

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return response(201, {
      message: "Account created successfully.",
      token,
      user
    });

  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {}
    }

    console.error("Registration error:", error);

    return response(500, {
      message: "Registration failed. Please try again."
    });

  } finally {
    if (client) client.release();
  }
};