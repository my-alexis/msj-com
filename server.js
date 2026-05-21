const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 5000;

// Configurar multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

const initUploadsFolder = async () => {
    try {
        await fs.mkdir('uploads', { recursive: true });
    } catch (err) {
        console.error('Error creando carpeta uploads:', err);
    }
};

initUploadsFolder();

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cliente de WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "sesion-casa"
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled'
        ],
    }
});

let clientReady = false;
let qrCode = null;
let authStatus = 'disconnected'; // disconnected, connecting, authenticated

// Broadcast a todos los clientes WebSocket
const broadcast = (data) => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
};

client.on('qr', (qr) => {
    qrCode = qr;
    authStatus = 'connecting';
    console.log('QR generado, escanea con WhatsApp');
    broadcast({ type: 'qr', qr: qr, status: 'connecting' });
});

client.on('ready', () => {
    clientReady = true;
    authStatus = 'authenticated';
    console.log('✓ WhatsApp Web conectado');
    broadcast({ type: 'ready', status: 'authenticated' });
});

client.on('authenticated', () => {
    console.log('✓ Autenticación exitosa');
    qrCode = null;
    authStatus = 'authenticated';
});

client.on('auth_failure', (msg) => {
    console.error('Error de autenticación:', msg);
    authStatus = 'disconnected';
    broadcast({ type: 'auth_failure', status: 'disconnected' });
});

client.on('disconnected', (reason) => {
    clientReady = false;
    authStatus = 'disconnected';
    console.log('Cliente desconectado:', reason);
    broadcast({ type: 'disconnected', status: 'disconnected' });
});

console.log('Iniciando WhatsApp Web...\n');
client.initialize().catch(err => {
    console.error('Error al inicializar WhatsApp:', err);
});

// WebSocket
wss.on('connection', (ws) => {
    console.log('Cliente WebSocket conectado');
    ws.send(JSON.stringify({ 
        type: 'status', 
        status: authStatus,
        qr: qrCode
    }));
});

// Rutas
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', (req, res) => {
    res.json({ status: authStatus, connected: clientReady });
});

app.post('/enviar-masivo', upload.single('archivo'), async (req, res) => {
    const { numeros, mensaje } = req.body;
    const numerosArray = JSON.parse(numeros);

    if (!clientReady) {
        return res.status(503).json({ 
            success: false, 
            error: 'WhatsApp no está conectado.' 
        });
    }

    console.log(`[INICIO] Envío masivo a ${numerosArray.length} destinatarios`);
    
    let media = null;
    if (req.file) {
        try {
            media = MessageMedia.fromFilePath(req.file.path);
        } catch (error) {
            console.error('Error al cargar archivo:', error.message);
        }
    }

    const LOTE_SIZE = 40;
    const PAUSA_LOTE = 10 * 60 * 1000; // 10 minutos
    const PAUSA_MIN = 8000;
    const PAUSA_MAX = 15000;

    let totalEnviados = 0;
    let totalFallidos = 0;
    const totalContactos = numerosArray.length;

    for (let i = 0; i < numerosArray.length; i += LOTE_SIZE) {
        const lote = numerosArray.slice(i, i + LOTE_SIZE);
        
        for (const num of lote) {
            if (!num.trim()) continue;
            const chatId = `${num.trim()}@c.us`;

            try {
                if (media) {
                    const isAudio = req.file.mimetype.startsWith('audio/');
                    if (isAudio) {
                        await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
                        if (mensaje.trim()) await client.sendMessage(chatId, mensaje);
                    } else {
                        await client.sendMessage(chatId, media, { caption: mensaje });
                    }
                } else {
                    await client.sendMessage(chatId, mensaje);
                }
                totalEnviados++;
                broadcast({ 
                    type: 'progress', 
                    enviados: totalEnviados, 
                    total: totalContactos,
                    porcentaje: Math.round((totalEnviados / totalContactos) * 100)
                });
            } catch (error) {
                totalFallidos++;
                console.log(`✗ ${num}`);
            }

            const pausa = Math.floor(Math.random() * (PAUSA_MAX - PAUSA_MIN + 1)) + PAUSA_MIN;
            await new Promise(r => setTimeout(r, pausa));
        }

        // Pausa entre lotes (si no es el último)
        if (i + LOTE_SIZE < numerosArray.length) {
            console.log(`\n⏸️ Pausa de 10 minutos antes del próximo lote...`);
            for (let t = PAUSA_LOTE; t > 0; t -= 1000) {
                broadcast({ 
                    type: 'pause', 
                    tiempoRestante: Math.ceil(t / 1000)
                });
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    if (req.file) await fs.unlink(req.file.path).catch(() => {});

    console.log(`\n[RESUMEN] Enviados: ${totalEnviados}, Fallidos: ${totalFallidos}`);

    res.json({ success: true, enviados: totalEnviados, fallidos: totalFallidos });
});

server.listen(PORT, () => {
    console.log(`Servidor activo en http://localhost:${PORT}`);
});