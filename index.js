require('dotenv').config();
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const {
    initializeDatabase,
    addTransaction,
    getBalances,
    eraseTransactions,
    setBalance,
    getLastTransaction,
    updateTransaction
} = require('./database/db');

// Configurar pino para logging detallado
const logger = P({ level: 'info' });

// Reemplaza con el ID del grupo específico que deseas monitorear
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID;

// Mapeo de números de teléfono a nombres
const userMap = JSON.parse(process.env.USER_MAP);

// Función para obtener el nombre del usuario
function getUserName(jid) {
    return userMap[jid] || jid;
}

// Función para obtener la contraparte
function getCounterpart(senderJid) {
    if (senderJid === '573103970422@s.whatsapp.net') return '573004833170@s.whatsapp.net';
    if (senderJid === '573004833170@s.whatsapp.net') return '573103970422@s.whatsapp.net';
    return null;
}

// Función para formatear los valores como moneda colombiana
function formatCurrency(value) {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP' }).format(value);
}

// Mapa para almacenar descripciones pendientes y correcciones pendientes
const pendingDescriptions = new Map();
const pendingCorrections = new Map();

// Texto de ayuda
const helpText = `
Comandos disponibles:

1. !miti <monto> - Divide el monto entre dos y actualiza los balances correspondientes. La mitad del monto se debe a la otra persona.
2. !subtract <monto> - Similar a !miti, pero resta el monto en lugar de sumarlo.
3. !debe <monto> - Registra el monto completo como una deuda de la otra parte.
4. !pago <monto> - Registra el monto completo como un abono de la deuda de la otra parte.
5. !setbalance <monto> - Establece el balance inicial al monto especificado y ajusta el balance de la contraparte al negativo del mismo monto.
6. !balance - Muestra el balance actual y resume quién le debe a quién.
7. !erase - Restablece todos los balances a cero.
8. !ayuda - Muestra esta lista de comandos y sus descripciones.
9. !corregir - Corrige el último registro.
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
                setTimeout(connectToWhatsApp, 5000); // Reconnect after 5 seconds
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

        // Log detailed information about the message
        logger.info(`Received message from ${getUserName(senderJid)}:`);
        logger.info(`Remote JID: ${remoteJid}`);
        logger.info(`Message content: ${JSON.stringify(msg.message, null, 2)}`);

        if (isGroupMessage) {
            logger.info(`Group message from: ${remoteJid}`);
        }

        // Verifica si el mensaje proviene del grupo específico
        if (remoteJid !== TARGET_GROUP_ID) {
            return;
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (!text) {
            logger.warn(`Received a message with no text from ${getUserName(senderJid)}`);
            return;
        }

        // Check if there's a pending description for the sender
        if (pendingDescriptions.has(senderJid)) {
            const { command, amount, counterpartJid } = pendingDescriptions.get(senderJid);
            const description = text;
            pendingDescriptions.delete(senderJid);

            if (command === '!debe') {
                await addTransaction(counterpartJid, -amount, description, 'debe');
                await sock.sendMessage(remoteJid, { text: `Registro: ${formatCurrency(amount)} debe ${getUserName(counterpartJid)} a ${getUserName(senderJid)} - ${description}` });
                logger.info(`Debe ${formatCurrency(amount)} to ${getUserName(counterpartJid)} by ${getUserName(senderJid)} - ${description}`);
            } else if (command === '!pago') {
                await addTransaction(counterpartJid, -amount, description, 'pago');
                await sock.sendMessage(remoteJid, { text: `Registro: ${formatCurrency(amount)} abono de ${getUserName(senderJid)} a ${getUserName(counterpartJid)} - ${description}` });
                logger.info(`Abono ${formatCurrency(amount)} from ${getUserName(senderJid)} to ${getUserName(counterpartJid)} - ${description}`);
            } else if (command === '!setbalance') {
                await setBalance(senderJid, counterpartJid, amount, description);
                await sock.sendMessage(remoteJid, { text: `Balance establecido: ${formatCurrency(amount)} a favor de ${getUserName(senderJid)} y ${formatCurrency(-amount)} a ${getUserName(counterpartJid)} - ${description}` });
                logger.info(`Balance set to ${formatCurrency(amount)} for ${getUserName(senderJid)} and ${formatCurrency(-amount)} for ${getUserName(counterpartJid)} - ${description}`);
            } else {
                const halfAmount = amount / 2;
                await addTransaction(senderJid, halfAmount, description, 'miti');
                await addTransaction(counterpartJid, -halfAmount, description, 'miti');
                await sock.sendMessage(remoteJid, { text: `Transacción registrada: ${formatCurrency(halfAmount)} pagó ${getUserName(senderJid)}, ${formatCurrency(halfAmount)} debe ${getUserName(counterpartJid)} - ${description}` });
                logger.info(`Recorded transaction of ${formatCurrency(halfAmount)} credited to ${getUserName(senderJid)} and debited from ${getUserName(counterpartJid)} - ${description}`);
            }
            return;
        }

        // Check if there's a pending correction for the sender
        if (pendingCorrections.has(senderJid)) {
            const { transactionId, stage, type, counterpartJid, originalAmount } = pendingCorrections.get(senderJid);
            if (stage === 'confirm') {
                if (text.toLowerCase() === 'si') {
                    pendingCorrections.set(senderJid, { transactionId, stage: 'newAmount', type, counterpartJid, originalAmount });
                    await sock.sendMessage(remoteJid, { text: 'Por favor ingresa el nuevo monto.' });
                } else {
                    pendingCorrections.delete(senderJid);
                    await sock.sendMessage(remoteJid, { text: 'Corrección cancelada.' });
                }
            } else if (stage === 'newAmount') {
                let newAmount = parseInt(text.replace(/\./g, ''), 10);
                if (!isNaN(newAmount)) {
                    pendingCorrections.set(senderJid, { transactionId, newAmount, stage: 'newDescription', type, counterpartJid, originalAmount });
                    await sock.sendMessage(remoteJid, { text: 'Por favor ingresa la nueva descripción.' });
                } else {
                    await sock.sendMessage(remoteJid, { text: 'Monto inválido. Corrección cancelada.' });
                    pendingCorrections.delete(senderJid);
                }
            } else if (stage === 'newDescription') {
                const newDescription = text;
                const { newAmount, type, counterpartJid, originalAmount } = pendingCorrections.get(senderJid);
                
                if (type === 'miti') {
                    const halfOriginal = originalAmount / 2;
                    const halfNew = newAmount / 2;
                    await updateTransaction(transactionId, halfNew, newDescription);
                    const counterpartTransaction = await getLastTransaction(counterpartJid);
                    if (counterpartTransaction) {
                        await updateTransaction(counterpartTransaction.id, -halfNew, newDescription);
                    }
                } else if (type === 'debe' || type === 'pago') {
                    await updateTransaction(transactionId, -newAmount, newDescription);
                }

                pendingCorrections.delete(senderJid);
                await sock.sendMessage(remoteJid, { text: 'Transacción corregida exitosamente.' });
                logger.info(`Transaction ${transactionId} updated to amount: ${newAmount}, description: ${newDescription}`);
            }
            return;
        }

        const match = text.match(/^(!miti|!subtract|!debe|!pago|!setbalance|!corregir)(?:\s+(-?[\d.]+))?$/);
        if (match) {
            const command = match[1];
            let amount = match[2] ? parseInt(match[2].replace(/\./g, ''), 10) : null;

            if (command === '!subtract' && amount !== null) {
                amount = -amount;
            }

            if (command === '!corregir') {
                const counterpartJid = getCounterpart(senderJid);
                const lastTransaction = await getLastTransaction(senderJid, counterpartJid);
                if (lastTransaction) {
                    pendingCorrections.set(senderJid, { transactionId: lastTransaction.id, stage: 'confirm', type: lastTransaction.type, counterpartJid, originalAmount: lastTransaction.amount });
                    await sock.sendMessage(remoteJid, {
                        text: `Último registro:\nMonto: ${formatCurrency(lastTransaction.amount)}\nDescripción: ${lastTransaction.description}\nFecha: ${lastTransaction.timestamp}\n\n¿Deseas continuar con la corrección? (responde con "si" o "no")`,
                    });
                } else {
                    await sock.sendMessage(remoteJid, { text: 'No se encontró ninguna transacción anterior para corregir.' });
                }
            } else if (amount !== null) {
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

            balances.forEach(balance => {
                response += `${getUserName(balance.user)}: ${formatCurrency(balance.balance)}\n`;
                if (balance.balance < 0) {
                    debtSummary += `${getUserName(balance.user)} le debe ${formatCurrency(-balance.balance)} a ${getUserName(getCounterpart(balance.user))}\n`;
                }
            });

            response += '\nResumen de deudas:\n' + (debtSummary || 'No hay deudas pendientes.');

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
        process.exit(1); // Salir si no se puede inicializar la base de datos
    }
}

connectToWhatsApp();
