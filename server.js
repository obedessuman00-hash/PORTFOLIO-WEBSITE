
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const CURRENCY = "GHS";
const MIN_AMOUNT_PESEWAS = 50;       // GHS 0.50
const MAX_AMOUNT_PESEWAS = 1000000;  // GHS 10,000.00

app.use(
  express.json({
    limit: "20kb",
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);

app.use(express.static(path.join(__dirname, "public")));

function validEmail(email) {
  return (
    typeof email === "string" &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function amountToPesewas(value) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === ""
  ) {
    return null;
  }

  // Reject malformed values and amounts with more than 2 decimals.
  const text = String(value).trim();

  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;

  const amount = Number(text);

  if (!Number.isFinite(amount)) return null;

  const pesewas = Math.round(amount * 100);

  if (
    pesewas < MIN_AMOUNT_PESEWAS ||
    pesewas > MAX_AMOUNT_PESEWAS
  ) {
    return null;
  }

  return pesewas;
}

// Initialize a new donation with Paystack.
app.post("/api/donate", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: "Payment service is not configured.",
      });
    }

    const { email, amount } = req.body || {};

    if (!validEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address.",
      });
    }

    const amountPesewas = amountToPesewas(amount);

    if (amountPesewas === null) {
      return res.status(400).json({
        success: false,
        message:
          "Enter an amount from GHS 0.50 to GHS 10,000.00, with at most 2 decimal places.",
      });
    }

    const reference = `DONATION-${crypto.randomUUID()}`;
    
db.prepare(`
  INSERT INTO donations
    (reference, email, amount_pesewas, currency, status)
  VALUES (?, ?, ?, ?, ?)
`).run(
  reference,
  email,
  amountPesewas,
  CURRENCY,
  "pending"
);


    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          amount: amountPesewas,
          currency: CURRENCY,
          reference,
          metadata: {
            purpose: "portfolio_donation",
            expected_amount_pesewas: amountPesewas,
          },
        }),
      }
    );

    const result = await response.json();

    if (
      !response.ok ||
      !result.status ||
      !result.data?.authorization_url
    ) {
      console.error(
        "Paystack initialization failed:",
        result.message
      );

      return res.status(502).json({
        success: false,
        message: "Unable to start the payment. Please try again.",
      });
    }

    return res.json({
      success: true,
      authorization_url: result.data.authorization_url,
      access_code: result.data.access_code,
      reference: result.data.reference,
    });
  } catch (error) {
    console.error("Donation initialization error:", error.message);

    return res.status(500).json({
      success: false,
      message: "A server error occurred while starting payment.",
    });
  }
});

// Verify a donation with Paystack.
app.get("/api/verify/:reference", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: "Payment service is not configured.",
      });
    }

    const reference = req.params.reference;

    if (
      typeof reference !== "string" ||
      !/^DONATION-[a-f0-9-]{36}$/i.test(reference)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid transaction reference.",
      });
    }

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const result = await response.json();

    if (!response.ok || !result.status || !result.data) {
      return res.status(502).json({
        success: false,
        message: "Unable to verify the payment right now.",
      });
    }


const transaction = result.data;

// Find the donation we originally saved in SQLite.
const savedDonation = db.prepare(`
  SELECT reference, amount_pesewas, currency, status
  FROM donations
  WHERE reference = ?
`).get(reference);

if (!savedDonation) {
  return res.status(404).json({
    success: false,
    paid: false,
    message: "Donation reference was not found.",
  });
}

const paymentSuccessful =
  result.data.status === "success" &&
  result.data.reference === reference &&
  result.data.currency === savedDonation.currency &&
  Number(result.data.amount) === savedDonation.amount_pesewas;

if (!paymentSuccessful) {
  return res.json({
    success: true,
    paid: false,
    status: result.data.status,
    message: "Payment is not confirmed or does not match the saved donation.",
  });
}

if (savedDonation.status !== "paid") {
  const update = db.prepare(`
    UPDATE donations
    SET status = 'paid'
    WHERE reference = ?
      AND amount_pesewas = ?
      AND currency = ?
      AND status = 'pending'
  `).run(
    reference,
    savedDonation.amount_pesewas,
    savedDonation.currency
  );

  if (update.changes === 0) {
    const current = db.prepare(
      "SELECT status FROM donations WHERE reference = ?"
    ).get(reference);

    if (current?.status !== "paid") {
      return res.status(409).json({
        success: false,
        paid: false,
        message: "Could not update the donation record.",
      });
    }
  }
}


const paid =
  transaction.status === "success" &&
  transaction.reference === savedDonation.reference &&
  transaction.reference === reference &&
  transaction.currency === savedDonation.currency &&
  transaction.amount === savedDonation.amount_pesewas;

// Update the database only after Paystack confirms a matching payment.
if (paid && savedDonation.status !== "paid") {
  db.prepare(`
    UPDATE donations
    SET status = 'paid'
    WHERE reference = ?
      AND amount_pesewas = ?
      AND currency = ?
  `).run(
    savedDonation.reference,
    savedDonation.amount_pesewas,
    savedDonation.currency
  );
}

return res.json({
  success: true,
  paid: true,
  reference,
  status: "success",
  amount: result.data.amount / 100,
  currency: result.data.currency,
});

// Configure this endpoint as the Paystack webhook URL after deployment.
app.post("/api/paystack-webhook", (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) return res.sendStatus(500);

    const signature = req.headers["x-paystack-signature"];

    if (!signature || !req.rawBody) {
      return res.sendStatus(401);
    }

    const expectedSignature = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(req.rawBody)
      .digest("hex");

    const received = Buffer.from(signature, "utf8");
    const expected = Buffer.from(expectedSignature, "utf8");

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) {
      return res.sendStatus(401);
    }

    const event = req.body;

   
if (event?.event === "charge.success") {
  const transaction = event.data;

  if (
    transaction?.status === "success" &&
    typeof transaction.reference === "string" &&
    transaction.currency === CURRENCY &&
    Number.isInteger(transaction.amount)
  ) {
    // Find the original donation in our database.
    const savedDonation = db.prepare(`
      SELECT reference, amount_pesewas, currency, status
      FROM donations
      WHERE reference = ?
    `).get(transaction.reference);

    // Only mark it paid if all stored details match.
    if (
      savedDonation &&
      savedDonation.status !== "paid" &&
      savedDonation.reference === transaction.reference &&
      savedDonation.currency === transaction.currency &&
      savedDonation.amount_pesewas === transaction.amount &&
      transaction.amount >= MIN_AMOUNT_PESEWAS &&
      transaction.amount <= MAX_AMOUNT_PESEWAS
    ) {
      db.prepare(`
        UPDATE donations
        SET status = 'paid'
        WHERE reference = ?
          AND amount_pesewas = ?
          AND currency = ?
          AND status = 'pending'
      `).run(
        savedDonation.reference,
        savedDonation.amount_pesewas,
        savedDonation.currency
      );

      console.log(
        `Donation verified: ${transaction.reference}, GHS ${(transaction.amount / 100).toFixed(2)}`
      );
    } else {
      console.log(
        `Donation not updated: reference or payment details did not match for ${transaction.reference}`
      );
    }
  }
}
 

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.message);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Portfolio server running on port ${PORT}`);
});
