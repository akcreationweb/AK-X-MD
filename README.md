# ⚔️ AK X MD — WhatsApp Bot Mini Base

A clean, minimal WhatsApp bot base built with Baileys + MongoDB, ready for Render deployment.

## Commands
| Command | Description |
|---------|-------------|
| `.menu` | Show the main menu |
| `.ping` | Check bot latency |

---

## 🚀 Deploy to Render

### Step 1 — Fork/Upload to GitHub
Push this folder to a GitHub repository.

### Step 2 — Create Render Web Service
1. Go to [render.com](https://render.com)
2. New → **Web Service**
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Environment:** Node

### Step 3 — Add Environment Variables in Render
| Key | Value |
|-----|-------|
| `MONGO_URI` | Your MongoDB connection string |
| `OWNER_NUMBER` | Your number e.g. `94700000000` |
| `PREFIX` | `.` (or any prefix you want) |

### Step 4 — Pair Your WhatsApp
1. Once deployed, open your Render URL
2. Enter your WhatsApp number
3. Click **PAIR** — you'll get a 8-digit code
4. On your phone: WhatsApp → ⋮ → Linked Devices → Link a Device → Link with Phone Number
5. Enter the code

---

## 📦 Project Structure
```
AK_X_MD/
├── index.js        # Express server entry
├── pair.js         # Bot logic + commands
├── main.html       # Pairing web UI
├── package.json
├── render.yaml     # Render deploy config
└── .env.example    # Environment variables template
```

---

## 🔧 Adding New Commands
In `pair.js`, find the `switch (command)` block and add a new `case`:

```js
case 'hello': {
  await reply('Hello World! 👋');
  break;
}
```

---

> ⚔️ **AK X MD** — Built clean, stays clean.
