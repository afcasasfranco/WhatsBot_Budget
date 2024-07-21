require('dotenv').config();
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const { initializeDatabase, addTransaction, getBalances, eraseTransactions } = require('./database/db');

// Configurar pino para logging detallado
const logger = P({ level: 'info' });

const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID;
const userMap = JSON.parse(process.env.USER_MAP);

function getUserName(jid) {
    return userMap[jid] || jid;
}

function getCounterpart(senderJid) {
    if (senderJid === '573103970422@s.whatsapp.net') return '573004833170@s.whatsapp.net';
    if (senderJid === '573004833170@s.whatsapp.net') return '573103970422@s.whatsapp.net';
    return null;
}

function formatCurrency(value) {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP' }).format(value);
}

const pendingDescriptions = new Map();

const helpText = `
Comandos disponibles:
1. !miti <monto> - Divide el monto entre dos y asigna la deuda a la contraparte.
2. !debe <monto> - Registra el monto completo como una deuda de la otra parte.
3. !pago <monto> - Registra el monto completo como un abono de la deuda de la otra parte.
4. !balance - Muestra el balance actual y resume quién le debe a quién.
5. !erase - Restablece todos los balances a cero.
6. !ayuda - Muestra esta lista de comandos y sus descripciones.
`;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        logger,
        printQRInTerminal: true,
        auth: state,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
            logger.info('QR code generated, scan with your phone');
        }
        if (connection === 'close') {
            const statusCode = (lastDisconnect.error = new Boom(lastDisconnect?.error))?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401;
            logger.error('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
            } else {
                logger.error('Not reconnecting due to unauthorized error or logged out');
            }
        } else if (connection === 'open') {
            logger.info('Opened connection');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

        const senderJid = msg.key.participant || msg.key.remoteJid;
        const remoteJid = msg.key.remoteJid;
        const isGroupMessage = remoteJid.endsWith('@g.us');

        logger.info(`Received message from ${getUserName(senderJid)}:`);
        logger.info(`Remote JID: ${remoteJid}`);
        logger.info(`Message content: ${JSON.stringify(msg.message, null, 2)}`);

        if (isGroupMessage) {
            logger.info(`Group message from: ${remoteJid}`);
        }

        if (remoteJid !== TARGET_GROUP_ID) {
            return;
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (!text) {
            logger.warn(`Received a message with no text from ${getUserName(senderJid)}`);
            return;
        }

        if (pendingDescriptions.has(senderJid)) {
            const { command, amount, counterpartJid } = pendingDescriptions.get(senderJid);
            const description = text;
            pendingDescriptions.delete(senderJid);

            if (command === '!debe') {
                await addTransaction(counterpartJid, -amount, description, 'debe');
                await sock.sendMessage(remoteJid, { text: `Registro: ${formatCurrency(amount)} debe ${getUserName(counterpartJid)} a ${getUserName(senderJid)} - ${description}` });
                logger.info(`Debe ${formatCurrency(amount)} to ${getUserName(counterpartJid)} by ${getUserName(senderJid)} - ${description}`);
            } else if (command === '!pago') {
                const balances = await getBalances();
                const senderBalance = balances.find(balance => balance.user === senderJid)?.balance || 0;

                if (senderBalance < 0) {
                    await addTransaction(senderJid, amount, description, 'pago');
                } else {
                    await addTransaction(counterpartJid, -amount, description, 'debe');
                }

                await sock.sendMessage(remoteJid, { text: `Registro: ${formatCurrency(amount)} abono de ${getUserName(senderJid)} a ${getUserName(counterpartJid)} - ${description}` });
                logger.info(`Abono ${formatCurrency(amount)} from ${getUserName(senderJid)} to ${getUserName(counterpartJid)} - ${description}`);
            } else {
                const halfAmount = Math.ceil(amount / 2);
                await addTransaction(counterpartJid, -halfAmount, description, 'miti');
                await sock.sendMessage(remoteJid, { text: `Transacción registrada: ${formatCurrency(halfAmount)} debe ${getUserName(counterpartJid)} a ${getUserName(senderJid)} - ${description}` });
                logger.info(`Recorded transaction of ${formatCurrency(halfAmount)} debited from ${getUserName(counterpartJid)} - ${description}`);
            }
            return;
        }

        const match = text.match(/^(!miti|!debe|!pago)(?:\s+(-?[\d.]+))?$/);
        if (match) {
            const command = match[1];
            let amount = match[2] ? parseInt(match[2].replace(/\./g, ''), 10) : null;

            if (amount !== null) {
                const counterpartJid = getCounterpart(senderJid);
                if (counterpartJid) {
                    pendingDescriptions.set(senderJid, { command, amount, counterpartJid });
                    await sock.sendMessage(remoteJid, { text: 'Por favor proporciona una descripción para esta transacción.' });
                } else {
                    logger.warn(`No counterpart found for ${getUserName(senderJid)}`);
                }
            } else {
                await sock.sendMessage(remoteJid, { text: 'Monto inválido' });
                logger.warn(`Invalid amount received from ${getUserName(senderJid)}: ${text}`);
            }
        } else if (text === '!balance') {
            const balances = await getBalances();
            let response = 'Este es el balance actual:\n';
            let debtSummary = '';

            const balancesMap = {
                '573103970422@s.whatsapp.net': 0,
                '573004833170@s.whatsapp.net': 0,
            };

            balances.forEach(balance => {
                balancesMap[balance.user] = balance.balance;
                response += `${getUserName(balance.user)}: ${formatCurrency(balance.balance)}\n`;
            });

            const netBalance = balancesMap['573103970422@s.whatsapp.net'] - balancesMap['573004833170@s.whatsapp.net'];

            if (netBalance > 0) {
                debtSummary = `${getUserName('573004833170@s.whatsapp.net')} le debe ${formatCurrency(netBalance)} a ${getUserName('573103970422@s.whatsapp.net')}`;
            } else if (netBalance < 0) {
                debtSummary = `${getUserName('573103970422@s.whatsapp.net')} le debe ${formatCurrency(-netBalance)} a ${getUserName('573004833170@s.whatsapp.net')}`;
            } else {
                debtSummary = 'No hay deudas pendientes.';
            }

            response += '\nResumen de deudas:\n' + debtSummary;

            await sock.sendMessage(remoteJid, { text: response });
            logger.info(`Sent balance to ${remoteJid}`);
        } else if (text === '!erase') {
            await eraseTransactions();
            await sock.sendMessage(remoteJid, { text: 'Todos los balances se han reiniciado a cero.' });
            logger.info(`All balances reset by ${getUserName(senderJid)}`);
        } else if (text === '!ayuda') {
            await sock.sendMessage(remoteJid, { text: helpText });
            logger.info(`Sent help text to ${remoteJid}`);
        } else {
            logger.info(`Unrecognized command from ${getUserName(senderJid)}: ${text}`);
        }
    });

    try {
        await initializeDatabase();
        logger.info('Database initialized');
    } catch (err) {
        logger.error('Failed to initialize the database:', err);
        process.exit(1);
    }
}

connectToWhatsApp();
