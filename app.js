const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');

// Configuration
const config = {
  port: 3001,
  n8nWebhookUrl: 'https://n8n-render-docker-hg4q.onrender.com/webhook/whatsapp-incoming',
  sessionPath: './wa_session',
  logLevel: 'info',
};

// Express app setup
const app = express();
app.use(express.json());
app.use(express.static('public')); // Serve static files

// Global variables
let sock;
let isConnected = false;
let currentQR = null;

// Logger
const logger = pino({ level: config.logLevel });

// Initialize WhatsApp connection
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(config.sessionPath);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['WhatsApp AI Bridge', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000, // 60 seconds
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 10000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      printQRInTerminal: false,
      getMessage: async () => undefined,
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n🔗 QR Code generated - check http://localhost:' + config.port + ' to scan');
        qrcode.generate(qr, { small: true }); // Still show in terminal
        
        // Generate QR code for web display
        try {
          currentQR = await QRCode.toDataURL(qr);
          console.log('✅ QR Code ready for web display');
        } catch (err) {
          console.error('❌ Error generating QR code:', err);
        }
      }

      if (connection === 'close') {
        currentQR = null; // Clear QR code
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log('❌ Connection closed due to:', lastDisconnect?.error);

        if (shouldReconnect) {
          console.log('🔄 Reconnecting in 5 seconds...');
          setTimeout(() => {
            connectToWhatsApp();
          }, 5000); // Wait 5 seconds before reconnecting
        } else {
          console.log('⚠️  Logged out. Delete session and restart.');
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp connected successfully!');
        currentQR = null; // Clear QR code when connected
        isConnected = true;
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
      if (!m.messages || !m.messages[0]) return;
      const message = m.messages[0];

      if (!message.key.fromMe && m.type === 'notify') {
        await handleIncomingMessage(message);
      }
    });

  } catch (error) {
    logger.error('Failed to connect to WhatsApp:', error);
    console.log('🔄 Retrying connection in 10 seconds...');
    setTimeout(connectToWhatsApp, 10000); // Wait 10 seconds on general errors
  }
}

// Handle incoming WhatsApp messages
async function handleIncomingMessage(message) {
  try {
    const from = message.key.remoteJid;
    const messageType = Object.keys(message.message || {})[0];
    let text = '';

    if (messageType === 'conversation') {
      text = message.message.conversation;
    } else if (messageType === 'extendedTextMessage') {
      text = message.message.extendedTextMessage.text;
    } else if (messageType === 'imageMessage' && message.message.imageMessage.caption) {
      text = message.message.imageMessage.caption;
    } else {
      return;
    }

    const cleanFrom = from.replace('@s.whatsapp.net', '').replace('@c.us', '');

    const messageData = {
      from: cleanFrom,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      messageId: message.key.id,
      messageType: messageType
    };

    logger.info('📨 Incoming message:', { from: cleanFrom, text: text.substring(0, 50) + '...' });

    const n8nResponse = await sendToN8n(messageData);

    // Updated response handling - more flexible approach
    let responseText = null;
    
    if (n8nResponse) {
      // Log the actual response structure for debugging
      logger.info('🔍 Full n8n response:', n8nResponse);
      
      // Try different possible response structures
      if (n8nResponse.reply) {
        responseText = n8nResponse.reply;
      } else if (n8nResponse.message) {
        responseText = n8nResponse.message;
      } else if (n8nResponse.text) {
        responseText = n8nResponse.text;
      } else if (typeof n8nResponse === 'string') {
        responseText = n8nResponse;
      } else if (n8nResponse.response) {
        responseText = n8nResponse.response;
      } else if (n8nResponse.data) {
        responseText = n8nResponse.data;
      }
    }

    if (responseText) {
      await sendWhatsAppReply(from, responseText);
    } else {
      logger.warn('⚠️ No reply from n8n or invalid format. Response:', n8nResponse);
    }

  } catch (error) {
    logger.error('Error handling incoming message:', error);
  }
}

// Send message data to n8n
async function sendToN8n(messageData) {
  try {
    const response = await axios.post(config.n8nWebhookUrl, messageData, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    logger.info('✅ Message sent to n8n. Received response:', response.data);
    return response.data;

  } catch (error) {
    logger.error('❌ Failed to send message to n8n:', error.message);
    if (error.response) {
      logger.error('❌ n8n Response Data:', error.response.data);
    }
    return null;
  }
}

// Send reply back to WhatsApp
async function sendWhatsAppReply(to, text) {
  try {
    await sock.sendMessage(to, { text });
    logger.info('📤 Sent AI reply to WhatsApp:', { to, text: text.substring(0, 50) + '...' });
  } catch (error) {
    logger.error('❌ Failed to send reply to WhatsApp:', error.message);
  }
}

// Frontend routes
app.get('/', (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp AI Bridge</title>
        <style>
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                margin: 0;
                padding: 0;
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
            }
            .container {
                background: rgba(255, 255, 255, 0.95);
                backdrop-filter: blur(10px);
                border-radius: 20px;
                padding: 40px;
                box-shadow: 0 15px 35px rgba(0, 0, 0, 0.1);
                text-align: center;
                max-width: 500px;
                width: 90%;
            }
            .header {
                margin-bottom: 30px;
            }
            h1 {
                color: #333;
                margin: 0;
                font-size: 2.5em;
                background: linear-gradient(45deg, #25D366, #128C7E);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
            }
            .subtitle {
                color: #666;
                margin-top: 10px;
                font-size: 1.1em;
            }
            .status {
                display: inline-block;
                padding: 10px 20px;
                border-radius: 25px;
                font-weight: bold;
                margin: 20px 0;
                font-size: 1.1em;
            }
            .connected {
                background: #d4edda;
                color: #155724;
                border: 2px solid #c3e6cb;
            }
            .disconnected {
                background: #f8d7da;
                color: #721c24;
                border: 2px solid #f5c6cb;
            }
            .qr-container {
                margin: 30px 0;
                padding: 20px;
                background: white;
                border-radius: 15px;
                box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
            }
            .qr-code {
                max-width: 300px;
                width: 100%;
                height: auto;
                border-radius: 10px;
            }
            .instructions {
                color: #555;
                margin-top: 20px;
                line-height: 1.6;
            }
            .refresh-btn {
                background: linear-gradient(45deg, #25D366, #128C7E);
                color: white;
                border: none;
                padding: 12px 30px;
                border-radius: 25px;
                font-size: 1em;
                cursor: pointer;
                margin-top: 20px;
                transition: all 0.3s ease;
            }
            .refresh-btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 5px 15px rgba(37, 211, 102, 0.4);
            }
            .loading {
                display: inline-block;
                width: 40px;
                height: 40px;
                border: 4px solid #f3f3f3;
                border-top: 4px solid #25D366;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 20px 0;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🚀 WhatsApp AI Bridge</h1>
                <p class="subtitle">Connect your WhatsApp to AI Assistant</p>
            </div>
            
            <div id="status-container">
                <div class="loading" id="loading"></div>
                <p>Loading status...</p>
            </div>
            
            <div id="qr-container" style="display: none;">
                <div class="qr-container">
                    <img id="qr-code" class="qr-code" alt="QR Code" />
                    <div class="instructions">
                        <p><strong>📱 Scan this QR code with WhatsApp:</strong></p>
                        <p>1. Open WhatsApp on your phone</p>
                        <p>2. Tap Menu (⋮) > Linked Devices</p>
                        <p>3. Tap "Link a Device"</p>
                        <p>4. Scan this QR code</p>
                    </div>
                </div>
            </div>
            
            <button class="refresh-btn" onclick="checkStatus()">🔄 Refresh Status</button>
        </div>

        <script>
            async function checkStatus() {
                try {
                    const response = await fetch('/qr-status');
                    const data = await response.json();
                    
                    const statusContainer = document.getElementById('status-container');
                    const qrContainer = document.getElementById('qr-container');
                    
                    if (data.connected) {
                        statusContainer.innerHTML = '<div class="status connected">✅ WhatsApp Connected!</div><p>Your WhatsApp is successfully connected and ready to receive messages.</p>';
                        qrContainer.style.display = 'none';
                    } else if (data.qr) {
                        statusContainer.innerHTML = '<div class="status disconnected">📱 Scan QR Code to Connect</div>';
                        document.getElementById('qr-code').src = data.qr;
                        qrContainer.style.display = 'block';
                    } else {
                        statusContainer.innerHTML = '<div class="status disconnected">⏳ Generating QR Code...</div><p>Please wait while we generate your QR code.</p>';
                        qrContainer.style.display = 'none';
                    }
                } catch (error) {
                    console.error('Error checking status:', error);
                    document.getElementById('status-container').innerHTML = '<div class="status disconnected">❌ Error connecting to server</div>';
                }
            }
            
            // Check status on page load
            checkStatus();
            
            // Auto-refresh every 3 seconds
            setInterval(checkStatus, 3000);
        </script>
    </body>
    </html>
  `;
  res.send(html);
});

// QR status endpoint
app.get('/qr-status', (req, res) => {
  res.json({
    connected: isConnected,
    qr: currentQR,
    timestamp: new Date().toISOString()
  });
});

// API endpoint to send messages (called by n8n)
app.post('/send', async (req, res) => {
  try {
    const { to, text } = req.body;

    if (!isConnected) {
      return res.status(503).json({
        error: 'WhatsApp not connected',
        status: 'disconnected'
      });
    }

    if (!to || !text) {
      return res.status(400).json({
        error: 'Missing required fields: to, text'
      });
    }

    const formattedTo = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    await sock.sendMessage(formattedTo, {
      text: text
    });

    logger.info('📤 Message sent via /send endpoint:', { to, text: text.substring(0, 50) + '...' });

    res.json({
      success: true,
      message: 'Message sent successfully',
      to: to,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error sending message via /send endpoint:', error);
    res.status(500).json({
      error: 'Failed to send message',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    whatsapp: isConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  if (sock) {
    await sock.logout();
  }
  process.exit(0);
});

// Start the server
app.listen(config.port, () => {
  console.log(`🚀 Baileys WhatsApp Bridge running on port ${config.port}`);
  console.log(`🌐 Web Interface: http://localhost:${config.port}`);
  console.log(`📡 Health check: http://localhost:${config.port}/health`);
  console.log(`📊 Status: http://localhost:${config.port}/status`);
  console.log(`📨 Send endpoint: http://localhost:${config.port}/send`);

  connectToWhatsApp();
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});
