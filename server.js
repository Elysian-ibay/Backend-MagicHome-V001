/*
 * ============================================================
 *  ✦ ELYSIAN MAGIC HOME ✦ — V0.0.1
 *  Backend Server (Node.js + Express)
 * ============================================================
 *  Endpoints:
 *    GET  /api/status  → Status lampu saat ini
 *    POST /api/control → Kontrol lampu (toggle / ganti warna)
 *  Security:
 *    Header "x-api-key: SECRET_IOT_123" wajib pada semua /api/*
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== KONSTANTA ====================
const API_KEY = 'SECRET_IOT_123';
const ESP_TIMEOUT_MS = 10000;       // ESP32 dianggap offline setelah 10 detik tanpa polling
const MAX_BODY_SIZE = '10kb';       // Batas ukuran request body
const VALID_ACTIONS = ['toggle', 'color'];  // Daftar action yang valid
const COLOR_LABELS = ['Warna 1 (Relay 1)', 'Warna 2 (Relay 2)', 'Warna 1 + 2 (Both)'];
const COLOR_MODE_COUNT = 3;

// ==================== MIDDLEWARE ====================

// Enable CORS untuk semua origin (agar Frontend GitHub Pages bisa akses)
app.use(cors());

// Parse JSON body dengan batas ukuran
app.use(express.json({ limit: MAX_BODY_SIZE }));

// ==================== IN-MEMORY STATE ====================
// State lampu disimpan di memori server (akan reset jika server restart)
let lampState = {
  power: false,         // true = ON, false = OFF
  color: 0,             // 0 = Relay1(Warna1), 1 = Relay2(Warna2), 2 = Both
  lastUpdate: null,     // ISO timestamp update terakhir
  espConnected: false,  // true jika ESP32 polling dalam 10 detik terakhir
  lastEspPing: null     // Timestamp polling terakhir ESP32
};

// ==================== API KEY MIDDLEWARE ====================
// Verifikasi header x-api-key pada semua route /api/*
function verifyApiKey(req, res, next) {
  const clientKey = req.headers['x-api-key'];

  if (!clientKey || clientKey !== API_KEY) {
    console.log(`[AUTH] ❌ Request ditolak - API key invalid dari ${req.ip}`);
    return res.status(401).json({
      success: false,
      error: 'Unauthorized - API key tidak valid'
    });
  }

  next();
}

// Terapkan middleware ke semua route /api/*
app.use('/api', verifyApiKey);

// ==================== HELPER ====================

// Cek apakah ESP32 masih online (polling dalam ESP_TIMEOUT_MS terakhir)
function checkEspConnection() {
  if (lampState.lastEspPing) {
    const elapsed = Date.now() - new Date(lampState.lastEspPing).getTime();
    lampState.espConnected = elapsed < ESP_TIMEOUT_MS;
  } else {
    lampState.espConnected = false;
  }
}

// Map colorMode ke label yang readable
function getColorLabel(colorMode) {
  return COLOR_LABELS[colorMode] || 'Unknown';
}

// Buat response data object (DRY — digunakan di GET dan POST)
function buildResponseData() {
  checkEspConnection();
  return {
    power: lampState.power,
    color: lampState.color,
    colorLabel: getColorLabel(lampState.color),
    lastUpdate: lampState.lastUpdate,
    espConnected: lampState.espConnected,
    lastEspPing: lampState.lastEspPing
  };
}

// ==================== ENDPOINTS ====================

/**
 * GET /api/status
 * Mengembalikan status lampu saat ini.
 * Jika request dari ESP32 (query param device_id), update lastEspPing.
 */
app.get('/api/status', (req, res) => {
  const { device_id } = req.query;

  // Jika request dari ESP32, update ping timestamp
  if (device_id && typeof device_id === 'string' && device_id.length > 0) {
    lampState.lastEspPing = new Date().toISOString();
    lampState.espConnected = true;
    console.log(`[STATUS] 📡 ESP32 polling - Device: ${device_id}`);
  }

  res.json({
    success: true,
    data: buildResponseData()
  });
});

/**
 * POST /api/control
 * Menerima perintah kontrol dari Frontend atau ESP32.
 * Body: { action: "toggle" | "color", device_id?: string, power?: bool, color?: int }
 */
app.post('/api/control', (req, res) => {
  const { action, device_id, power, color } = req.body;

  // Validasi: action wajib ada
  if (!action || typeof action !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Parameter "action" diperlukan (toggle / color)'
    });
  }

  // Validasi: action harus salah satu dari VALID_ACTIONS
  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({
      success: false,
      error: 'Action tidak dikenali. Gunakan "toggle" atau "color".'
    });
  }

  const timestamp = new Date().toISOString();
  const source = (device_id && typeof device_id === 'string') ? device_id : 'Frontend';

  switch (action) {
    case 'toggle':
      // Jika power dikirim eksplisit dari ESP32, gunakan nilai itu
      // Jika tidak (dari Frontend), toggle state saat ini
      if (typeof power === 'boolean') {
        lampState.power = power;
      } else {
        lampState.power = !lampState.power;
      }
      lampState.lastUpdate = timestamp;
      console.log(`[CONTROL] ⚡ Power ${lampState.power ? 'ON' : 'OFF'} - Source: ${source}`);
      break;

    case 'color':
      // Jika color dikirim eksplisit dari ESP32, gunakan nilai itu
      // Jika tidak (dari Frontend), cycle ke mode berikutnya
      if (typeof color === 'number' && Number.isInteger(color) && color >= 0 && color < COLOR_MODE_COUNT) {
        lampState.color = color;
      } else {
        lampState.color = (lampState.color + 1) % COLOR_MODE_COUNT;
      }
      lampState.lastUpdate = timestamp;
      console.log(`[CONTROL] 🎨 Color -> ${getColorLabel(lampState.color)} - Source: ${source}`);
      break;

    // default tidak diperlukan karena sudah divalidasi di atas
  }

  // Jika dari ESP32, update ping
  if (device_id && typeof device_id === 'string') {
    lampState.lastEspPing = timestamp;
    lampState.espConnected = true;
  }

  res.json({
    success: true,
    message: `Action "${action}" berhasil dieksekusi`,
    data: buildResponseData()
  });
});

// ==================== STATIC FRONTEND ====================
// Serve Frontend folder sebagai static files
// Ini menghilangkan masalah CORS & Ad Blocker (ERR_BLOCKED_BY_CLIENT)
// karena Frontend dan API berada di origin yang sama (http://localhost:3000)
const frontendPath = path.join(__dirname, '..', 'Frontend');
app.use(express.static(frontendPath));

// ==================== API INFO ROUTE ====================
app.get('/api/info', verifyApiKey, (req, res) => {
  res.json({
    name: 'Elysian Magic Home API',
    version: '0.0.1',
    description: 'Smart Light Controller — IoT Backend',
    endpoints: {
      status: 'GET /api/status',
      control: 'POST /api/control { action: "toggle" | "color" }'
    }
  });
});

// ==================== 404 HANDLER ====================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.path} tidak ditemukan`
  });
});

// ==================== ERROR HANDLER ====================
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);

  // Handle JSON parse error (invalid body)
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      error: 'Request body bukan JSON yang valid'
    });
  }

  // Handle payload too large
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: 'Request body terlalu besar'
    });
  }

  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   ✦ ELYSIAN MAGIC HOME ✦ — Backend    ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Version : 0.0.1                      ║`);
  console.log(`║  Port    : ${String(PORT).padEnd(28)}║`);
  console.log(`║  API Key : ${API_KEY.padEnd(28)}║`);
  console.log('╚════════════════════════════════════════╝');
  console.log(`[SERVER] 🚀 Running at http://localhost:${PORT}`);
  console.log(`[SERVER] 🌐 Frontend: http://localhost:${PORT}`);
  console.log(`[SERVER] 📡 GET  /api/status`);
  console.log(`[SERVER] ⚡ POST /api/control`);
  console.log(`[SERVER] 📁 Static: ${frontendPath}`);
});
