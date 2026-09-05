# Telegram Automatic Channel Reposter

An automated Telegram channel reposting service built with Node.js and plain JavaScript. Configure forwarding rules once through an interactive Telegram Bot, and the MTProto listener automatically monitors source channels, replaces branding, appends footers, and publishes clean messages to your destination channels.

---

## 🌟 Key Features

- **Dual Telegram Architecture**:
  - **Telegram Bot API**: Powers the interactive setup wizard, `/start` menu, admin controls, and channel posting verification.
  - **Telegram MTProto Client (`teleproto`)**: Actively listens to real-time posts from configured public source channels.
- **Branding Replacement**: Automatically find and replace watermarks, username tags (`@OldChannel`), and links.
- **Custom Footer**: Append customizable footers to all reposted messages with Telegram formatting.
- **Media Support**:
  - Plain text posts
  - Single Photos with captions
  - Single Videos with captions
  - Documents and files with captions
  - **Media Groups (Albums)**: Reconstructed and dispatched together as a single album post using debounce aggregation.
- **Duplicate Prevention**: Mongoose and MongoDB Atlas compound indexes guarantee that messages are never reposted twice, even across restarts.
- **Protected Content Respect**: Safely respects Telegram's content protection rules without crashing.
- **Uptime Monitoring**: Built-in Express server with `/` and `/health` endpoints ready for Render.

---

## 📦 Required NPM Packages

All dependencies are standard, actively maintained npm packages:

| Package | Purpose |
| :--- | :--- |
| `express` | Lightweight HTTP server providing healthcheck endpoints |
| `dotenv` | Environment variable loader |
| `mongoose` | MongoDB Atlas object modeling and schema persistence |
| `node-telegram-bot-api` | Telegram Bot API client for interactive menus and publishing |
| `teleproto` | Actively maintained MTProto client for receiving channel posts |

---

## 🔑 Environment Variables

Create a `.env` file in the root directory based on `.env.example`:

```env
BOT_TOKEN=your_telegram_bot_token
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_SESSION=your_generated_string_session
MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.mongodb.net/telegram_reposter?retryWrites=true&w=majority
PORT=3000
```

---

## 🛠️ Step-by-Step Setup Guide

### 1. How to Create the Telegram Bot with BotFather

1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Choose a name for your bot (e.g., `My Reposter Bot`).
4. Choose a username ending in `bot` (e.g., `my_channel_reposter_bot`).
5. BotFather will provide an HTTP API token (e.g., `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
6. Copy this token into your `.env` file as `BOT_TOKEN`.

---

### 2. How to Obtain Telegram API ID and API Hash

1. Log in to [https://my.telegram.org](https://my.telegram.org) with your Telegram account phone number.
2. Go to **API development tools**.
3. Fill out the application form:
   - **App title**: e.g. `Channel Reposter`
   - **Short name**: e.g. `reposter`
   - **Platform**: `Other (Desktop / Server)`
4. Click **Create application**.
5. Copy your **`api_id`** (an integer) and **`api_hash`** (a hexadecimal string).
6. Add them to `.env` as `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.

---

### 3. How to Generate `TELEGRAM_SESSION` Locally

MTProto connects as a Telegram client using a reusable session string so you don't need to re-authenticate on every restart.

1. Ensure `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are in your `.env`.
2. Run the included session generator:
   ```bash
   node generateSession.js
   ```
3. Enter your phone number with country code (e.g. `+1234567890`).
4. Enter the verification code sent to your Telegram app (and your 2FA password if enabled).
5. The script will output a session string. Copy it and set:
   ```env
   TELEGRAM_SESSION=1BAAA...your_session_string...
   ```

---

### 4. How to Configure MongoDB Atlas

1. Create a free account at [MongoDB Atlas](https://www.mongodb.com/atlas).
2. Create a new cluster (the free M0 cluster is sufficient).
3. Under **Database Access**, create a database user with read/write privileges.
4. Under **Network Access**, add IP `0.0.0.0/0` (allow access from anywhere) so your cloud host can connect.
5. Click **Connect** > **Drivers** > **Node.js** to get your connection string.
6. Replace `<password>` and database name, then paste it into `.env`:
   ```env
   MONGODB_URI=mongodb+srv://dbUser:yourPassword@cluster0.mongodb.net/telegram_reposter?retryWrites=true&w=majority
   ```

---

## 💻 How to Run Locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Verify `.env` contains all credentials.

3. Start the application:
   ```bash
   node server.js
   ```

4. Console logs will confirm each subsystem:
   ```text
   [SERVER] Starting Auto Reposter Application...
   [DATABASE] MongoDB connected successfully
   [BOT] Bot initialized successfully (@your_bot_username)
   [MTProto] Connecting to Telegram MTProto network...
   [MTProto] Connected successfully
   [SERVER] Express server listening on http://0.0.0.0:3000
   ```

---

## 🤖 Using the Telegram Bot

1. Open your bot in Telegram and send `/start`.
2. Click **➕ Create Auto Forward**:
   - **Step 1**: Send the public source channel username (e.g. `@examplechannel`). The bot validates it.
   - **Step 2**: Send your destination channel username (e.g. `@mydestination`).
     *Note: Make sure your bot is added as an **Administrator** in your destination channel with **Post Messages** enabled.*
   - **Step 3**: Choose whether to replace branding. If Yes, specify the text to find (`@OldChannel`) and the replacement (`@MyChannel`).
   - **Step 4**: Choose whether to add a custom footer.
   - **Step 5**: Review the summary and click **✅ Activate**.
3. Once active, any new post published in the source channel will be immediately downloaded, processed, and reposted to your destination channel!
4. Click **📋 My Auto Forwards** anytime to pause, resume, or delete rules.
5. Click **⚙️ Settings** to inspect live diagnostic health.

---

## 🚀 How to Deploy on Render

1. Push your repository to GitHub or GitLab.
2. Sign in to [Render](https://render.com).
3. Click **New +** > **Web Service**.
4. Connect your repository.
5. Configure the service:
   - **Name**: `telegram-auto-reposter`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free or Starter
6. Under **Environment Variables**, add:
   - `BOT_TOKEN`
   - `TELEGRAM_API_ID`
   - `TELEGRAM_API_HASH`
   - `TELEGRAM_SESSION`
   - `MONGODB_URI`
   - `PORT`: `3000`
7. Click **Create Web Service**.
8. Render will deploy your service and automatically bind port 3000.
9. You can ping `https://your-service.onrender.com/health` to monitor service uptime.
