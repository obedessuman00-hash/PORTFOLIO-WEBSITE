
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function testConnection() {
  try {
    const result = await pool.query(
      "SELECT current_database() AS database, version() AS version"
    );

    console.log("Connected to PostgreSQL successfully!");
    console.log("Database:", result.rows[0].database);
    console.log("PostgreSQL:", result.rows[0].version);
  } catch (error) {
    console.error("Database connection failed:", error.message);
  } finally {
    await pool.end();
  }
}

testConnection();
