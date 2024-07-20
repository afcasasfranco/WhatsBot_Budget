const mariadb = require('mariadb');
const pool = mariadb.createPool({
    host: '192.168.50.250', 
    user: 'root', 
    password: '153190',
    database: 'whatsbot_budget',
    connectionLimit: 10,  // Incrementamos el límite de conexiones
    acquireTimeout: 10000 // Ajustamos el tiempo de espera para adquirir una conexión
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
        // Alter the table to add the 'type' column if it doesn't exist
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

async function setBalance(user, counterpart, amount, description) {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query("DELETE FROM transactions WHERE user = ? OR user = ?", [user, counterpart]);
        await conn.query("INSERT INTO transactions (user, amount, description, type) VALUES (?, ?, ?, ?)", [user, amount, description, 'setbalance']);
        await conn.query("INSERT INTO transactions (user, amount, description, type) VALUES (?, ?, ?, ?)", [counterpart, -amount, description, 'setbalance']);
    } catch (err) {
        console.error('Error setting balance:', err);
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

async function getLastTransaction(user, counterpartJid) {
    let conn;
    try {
        conn = await pool.getConnection();
        const rows = await conn.query(`
            SELECT * FROM transactions 
            WHERE (user = ? OR user = ?) 
            ORDER BY timestamp DESC 
            LIMIT 1
        `, [user, counterpartJid]);
        const lastTransaction = rows[0];
        
        if (lastTransaction && lastTransaction.type === 'miti') {
            lastTransaction.amount *= 2; // Si es de tipo miti, el monto fue la mitad del total
        }
        
        return lastTransaction; // Devuelve el último registro ajustado
    } catch (err) {
        console.error('Error retrieving last transaction:', err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

async function updateTransaction(id, newAmount, newDescription) {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query("UPDATE transactions SET amount = ?, description = ? WHERE id = ?", [newAmount, newDescription, id]);
    } catch (err) {
        console.error('Error updating transaction:', err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

module.exports = { initializeDatabase, addTransaction, getBalances, eraseTransactions, setBalance, getLastTransaction, updateTransaction };
