const mariadb = require('mariadb');
require('dotenv').config();

const pool = mariadb.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 10,
    acquireTimeout: 10000
});

async function initializeDatabase() {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query(`CREATE TABLE IF NOT EXISTS transactions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user VARCHAR(255) NOT NULL,
            amount INT NOT NULL,
            description TEXT,
            type VARCHAR(10),
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        const columns = await conn.query(`SHOW COLUMNS FROM transactions LIKE 'type'`);
        if (columns.length === 0) {
            await conn.query(`ALTER TABLE transactions ADD COLUMN type VARCHAR(10)`);
        }
    } catch (err) {
        console.error('Error initializing database:', err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

async function addTransaction(user, amount, description, type) {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query("INSERT INTO transactions (user, amount, description, type) VALUES (?, ?, ?, ?)", [user, amount, description, type]);
    } catch (err) {
        console.error('Error adding transaction:', err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

async function getBalances() {
    let conn;
    try {
        conn = await pool.getConnection();
        const rows = await conn.query("SELECT user, SUM(amount) as balance FROM transactions GROUP BY user");
        return rows;
    } catch (err) {
        console.error('Error getting balances:', err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

async function eraseTransactions() {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query("DELETE FROM transactions");
    } catch (err) {
        console.error('Error erasing transactions:', err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

module.exports = { initializeDatabase, addTransaction, getBalances, eraseTransactions };
