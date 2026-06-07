/*
 * ============================================================
 *  ✦ ELYSIAN MAGIC HOME ✦ — V0.0.1
 *  Vercel Serverless Function Entry Point
 * ============================================================
 *  File ini adalah wrapper untuk Vercel.
 *  Vercel membutuhkan module.exports = app (TANPA app.listen)
 *  app.listen() hanya dipakai untuk local development (server.js)
 * ============================================================
 */

const express = require('express');
const cors = require('cors');

const app = express();

// ==================== KONSTANTA ====================
const API_KEY = 'SECRET_IOT_123';
const ESP_TIMEOUT_MS = 10000;
const MAX_BODY_SIZE = '10kb';
const VALID_ACTIONS = ['toggle', 'color'];
const COLOR_LABELS = ['Warna 1 (Relay 1)', 'Warna 2 (Relay 2)', 'Warna 1 + 2 (Both)'];
const COLOR_MODE_COUNT = 3;

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ limit: MAX_BODY_SIZE }));

// ==================== IN-MEMORY STATE ====================
// ⚠️ CATATAN VERCEL: State ini akan RESET setiap cold start!
// Untuk production, ganti dengan database (Vercel KV, Redis, MongoDB, dll)
let lampState = {
  power: false,
  color: 0,
  lastUpdate: null,
  espConnected: false,
  lastEspPing: null,
  schedule: null // { on_time: '18:00', off_time: '06:00', timezone_offset: -420, last_trigger_id: null }
};

// ==================== API KEY MIDDLEWARE ====================
function verifyApiKey(req, res, next) {
  const clientKey = req.headers['x-api-key'];
  if (!clientKey || clientKey !== API_KEY) {
    console.log(`[AUTH] ❌ Request ditolak dari ${req.ip}`);
    return res.status(401).json({
      success: false,
      error: 'Unauthorized - API key tidak valid'
    });
  }
  next();
}

app.use('/api', verifyApiKey);

// ==================== HELPER ====================
function checkEspConnection() {
  if (lampState.lastEspPing) {
    const elapsed = Date.now() - new Date(lampState.lastEspPing).getTime();
    lampState.espConnected = elapsed < ESP_TIMEOUT_MS;
  } else {
    lampState.espConnected = false;
  }
}

function checkSchedule() {
  if (lampState.schedule) {
    const d = new Date();
    // Offset dalam menit (misal: WIB = -420)
    // Waktu lokal = UTC - Offset
    const localTime = new Date(d.getTime() - (lampState.schedule.timezone_offset * 60000));
    
    const hh = String(localTime.getUTCHours()).padStart(2, '0');
    const mm = String(localTime.getUTCMinutes()).padStart(2, '0');
    const currentTimeStr = `${hh}:${mm}`;
    
    // Mencegah trigger berulang pada menit yang sama
    const currentDateStr = `${localTime.getUTCFullYear()}-${localTime.getUTCMonth()}-${localTime.getUTCDate()}`;
    const triggerId = `${currentDateStr}_${currentTimeStr}`;
    
    if (lampState.schedule.last_trigger_id !== triggerId) {
      const timestamp = new Date().toISOString();
      let triggered = false;

      if (lampState.schedule.on_time === currentTimeStr && !lampState.power) {
        lampState.power = true;
        lampState.lastUpdate = timestamp;
        console.log(`[SCHEDULE] ⏰ Executed: Auto-ON at ${currentTimeStr}`);
        triggered = true;
      } else if (lampState.schedule.off_time === currentTimeStr && lampState.power) {
        lampState.power = false;
        lampState.lastUpdate = timestamp;
        console.log(`[SCHEDULE] ⏰ Executed: Auto-OFF at ${currentTimeStr}`);
        triggered = true;
      }

      if (triggered) {
        lampState.schedule.last_trigger_id = triggerId;
      }
    }
  }
}

function getColorLabel(colorMode) {
  return COLOR_LABELS[colorMode] || 'Unknown';
}

function buildResponseData() {
  checkEspConnection();
  checkSchedule();
  return {
    power: lampState.power,
    color: lampState.color,
    colorLabel: getColorLabel(lampState.color),
    lastUpdate: lampState.lastUpdate,
    espConnected: lampState.espConnected,
    lastEspPing: lampState.lastEspPing,
    schedule: lampState.schedule
  };
}

// ==================== ENDPOINTS ====================

// Health check
app.get('/api', (req, res) => {
  res.json({
    name: 'Elysian Magic Home API',
    version: '0.0.1',
    description: 'Smart Light Controller — IoT Backend (Vercel)',
    endpoints: {
      status: 'GET /api/status',
      control: 'POST /api/control { action: "toggle" | "color" }',
      set_schedule: 'POST /api/schedule { on_time: "18:00", off_time: "06:00", timezone_offset: -420 }'
    }
  });
});

// GET /api/status
app.get('/api/status', (req, res) => {
  const { device_id } = req.query;

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

// POST /api/control
app.post('/api/control', (req, res) => {
  const { action, device_id, power, color } = req.body;

  if (!action || typeof action !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Parameter "action" diperlukan (toggle / color)'
    });
  }

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
      if (typeof power === 'boolean') {
        lampState.power = power;
      } else {
        lampState.power = !lampState.power;
      }
      lampState.lastUpdate = timestamp;
      console.log(`[CONTROL] ⚡ Power ${lampState.power ? 'ON' : 'OFF'} - Source: ${source}`);
      break;

    case 'color':
      if (typeof color === 'number' && Number.isInteger(color) && color >= 0 && color < COLOR_MODE_COUNT) {
        lampState.color = color;
      } else {
        lampState.color = (lampState.color + 1) % COLOR_MODE_COUNT;
      }
      lampState.lastUpdate = timestamp;
      console.log(`[CONTROL] 🎨 Color -> ${getColorLabel(lampState.color)} - Source: ${source}`);
      break;
  }

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

// POST /api/schedule
app.post('/api/schedule', (req, res) => {
  const { on_time, off_time, timezone_offset } = req.body;

  if (typeof timezone_offset !== 'number') {
    return res.status(400).json({ success: false, error: 'timezone_offset diperlukan (number)' });
  }

  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  
  if (on_time && !timeRegex.test(on_time)) return res.status(400).json({ success: false, error: 'Format on_time tidak valid (HH:MM)' });
  if (off_time && !timeRegex.test(off_time)) return res.status(400).json({ success: false, error: 'Format off_time tidak valid (HH:MM)' });

  if (!on_time && !off_time) {
    lampState.schedule = null;
    console.log(`[SCHEDULE] ⏰ Cancelled`);
    return res.json({ success: true, message: 'Jadwal dibatalkan', data: buildResponseData() });
  }

  lampState.schedule = {
    on_time: on_time || null,
    off_time: off_time || null,
    timezone_offset: timezone_offset,
    last_trigger_id: null
  };

  console.log(`[SCHEDULE] ⏰ Set: ON=${on_time || '-'} | OFF=${off_time || '-'} (TZ Offset: ${timezone_offset}m)`);

  res.json({
    success: true,
    message: 'Jadwal berhasil diatur',
    data: buildResponseData()
  });
});

// ==================== EXPORT UNTUK VERCEL ====================
// Vercel membutuhkan module.exports = app (TANPA app.listen)
module.exports = app;
