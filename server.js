const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ─── Startup check ────────────────────────────────────────────────────────────
if (!OPENAI_API_KEY) {
  console.error('❌ ERROR: OPENAI_API_KEY environment variable is not set!');
  process.exit(1);
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50kb' }));

// ─── Rate limiter (per IP) — 30 requests/min per user ────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW = 60000;

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const userData = rateLimitMap.get(ip) || { count: 0, startTime: now };

  if (now - userData.startTime > RATE_WINDOW) {
    userData.count = 0;
    userData.startTime = now;
  }

  userData.count++;
  rateLimitMap.set(ip, userData);

  if (rateLimitMap.size > 1000) {
    for (const [key, val] of rateLimitMap) {
      if (now - val.startTime > RATE_WINDOW) rateLimitMap.delete(key);
    }
  }

  if (userData.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }

  next();
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
const PROMPTS = {
  improve:  'Improve this text to be clearer and more professional. Return only the improved text, nothing else:',
  formal:   'Rewrite this text in a formal, professional tone. Return only the rewritten text, nothing else:',
  concise:  'Make this text more concise without losing meaning. Return only the concise version, nothing else:',
  friendly: 'Rewrite this text in a warm, friendly, approachable tone. Return only the rewritten text, nothing else:'
};

// ─── OpenAI call with retry ───────────────────────────────────────────────────
async function callOpenAI(prompt, text, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 1024,
          temperature: 0.4,
          messages: [{ role: 'user', content: `${prompt}\n\n${text}` }]
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);
      const data = await response.json();

      if (response.status === 429) {
        const wait = attempt * 2000;
        console.warn(`OpenAI rate limited. Retrying in ${wait}ms... (attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) throw new Error(data.error?.message || `OpenAI error: ${response.status}`);

      const result = data.choices?.[0]?.message?.content?.trim();
      if (!result) throw new Error('Empty response from OpenAI');
      return result;

    } catch (err) {
      const isLastAttempt = attempt === retries;
      if (err.name === 'AbortError') {
        if (isLastAttempt) throw new Error('Request timed out. Please try again.');
        console.warn(`Attempt ${attempt} timed out. Retrying...`);
      } else if (isLastAttempt) {
        throw err;
      } else {
        console.warn(`Attempt ${attempt} failed: ${err.message}. Retrying...`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: '✅ LSC WriteFix server is running', version: '2.0', timestamp: new Date().toISOString() });
});

app.post('/rewrite', rateLimit, async (req, res) => {
  const { text, action } = req.body;

  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Invalid or missing text.' });
  if (!action || !PROMPTS[action]) return res.status(400).json({ error: 'Invalid action.' });
  if (text.trim().length < 5) return res.status(400).json({ error: 'Text is too short.' });
  if (text.length > 5000) return res.status(400).json({ error: 'Text too long. Select less than 5000 characters.' });

  try {
    const result = await callOpenAI(PROMPTS[action], text.trim());
    res.json({ result });
  } catch (err) {
    console.error(`[ERROR] /rewrite failed: ${err.message}`);
    res.status(500).json({ error: err.message || 'Something went wrong. Please try again.' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { console.error('[UNHANDLED]', err); res.status(500).json({ error: 'Internal error.' }); });

app.listen(PORT, () => {
  console.log(`✅ LSC WriteFix server running on port ${PORT}`);
  console.log(`🔐 OpenAI key loaded: ${OPENAI_API_KEY.slice(0, 8)}...`);
});

process.on('SIGTERM', () => { console.log('Shutting down...'); process.exit(0); });
