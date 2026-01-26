# Match.com AI Reply Assistant

A Chrome extension (Manifest V3) that provides AI-assisted reply suggestions for Match.com conversations.

## Features

- 🤖 **AI-Powered Replies**: Generate contextual, casual replies based on conversation history
- 💬 **Short Conversations**: Designed for brief exchanges (max 4 turns)
- 📱 **CTA Suggestions**: Automatically suggests moving to Instagram/Snap/coffee after 2-4 messages
- 🎯 **Non-Intrusive**: Only assists when you click the button - never auto-sends
- 💾 **State Management**: Tracks conversation turn counts per conversation

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the extension directory

## Configuration

### Backend Setup

The extension requires a backend server to handle AI reply generation. A complete backend is included in the `backend/` directory.

#### 1. Install Backend Dependencies

```bash
cd backend
npm install
```

#### 2. Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` and add your OpenAI API key:

```env
OPENAI_API_KEY=sk-your-openai-api-key-here
PORT=3000
```

Get your OpenAI API key from: https://platform.openai.com/api-keys

#### 3. Start the Backend Server

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

The server will run on `http://localhost:3000` by default.

#### 4. Update Extension with Backend URL

Open `content.js` and update the `BACKEND_URL`:

```javascript
const CONFIG = {
  BACKEND_URL: 'http://localhost:3000', // For local development
  // Or use your deployed backend: 'https://your-backend-api.com'
  // ...
};
```

**For Production**: Deploy the backend to a hosting service (Heroku, Railway, Render, etc.) and update the URL accordingly.

### Backend API Endpoints

The backend implements the following endpoints:

#### POST /generate-reply

Generates an AI-powered reply based on conversation context.

**Request:**
```json
{
  "messages": [
    { "text": "Hey! How's your day?", "isOutgoing": false },
    { "text": "Great! How about you?", "isOutgoing": true }
  ],
  "turnCount": 2,
  "requestCTA": false
}
```

**Response:**
```json
{
  "reply": "Doing well, thanks for asking!",
  "isCTA": false
}
```

**CTA Response Example:**
```json
{
  "reply": "Would love to continue chatting on Instagram! @username",
  "isCTA": true
}
```

#### GET /health

Health check endpoint to verify the server is running.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-01-26T12:00:00.000Z"
}
```

## Usage

1. Navigate to a conversation on Match.com
2. Look for the floating "✨ Generate AI Reply" button (bottom right)
3. Click the button to generate a reply
4. Review the generated reply in the message input field
5. Edit if needed, then send manually

## How It Works

1. **Detection**: Automatically detects when you're on a Match.com messages page
2. **Message Extraction**: Reads the last 4-6 messages from the conversation
3. **Turn Tracking**: Tracks how many messages have been exchanged per conversation
4. **AI Generation**: Sends messages to your backend API for AI reply generation
5. **CTA Logic**: After 2-4 turns, suggests moving conversation to Instagram/Snap/coffee
6. **State Storage**: Uses Chrome's local storage to remember conversation state

## File Structure

```
match-extension/
├── manifest.json       # Extension manifest (Manifest V3)
├── content.js         # Main content script (DOM interaction)
├── background.js      # Background service worker
├── popup.html         # Extension popup UI
├── popup.js           # Popup script
├── styles.css         # Floating button styles
├── README.md          # This file
└── backend/           # Backend server
    ├── server.js      # Express server with OpenAI integration
    ├── package.json   # Backend dependencies
    ├── .env.example   # Environment variables template
    └── .gitignore     # Git ignore file
```

**Note**: Icons are optional. To add custom icons, create `icon16.png`, `icon48.png`, and `icon128.png` and update `manifest.json` with icon paths.

## Technical Details

### Manifest V3
- Uses service worker for background tasks
- Content scripts injected on Match.com pages
- Minimal permissions (storage, activeTab)

### DOM Interaction
- Uses multiple strategies to find message elements
- Avoids fragile CSS selectors
- Prefers aria-labels, roles, and DOM structure
- Handles both textarea and contenteditable inputs

### Safety Features
- Never auto-sends messages
- One reply per click
- No bulk actions
- Human review required before sending

## Development

### Testing

1. **Start the backend server:**
   ```bash
   cd backend
   npm install
   cp .env.example .env
   # Edit .env and add your OPENAI_API_KEY
   npm start
   ```

2. **Load the extension:**
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the extension directory

3. **Test the extension:**
   - Navigate to Match.com and open a conversation
   - Open Chrome DevTools (F12) to see console logs
   - Click the floating "✨ Generate AI Reply" button
   - Verify the reply appears in the message input field

### Debugging

- Check browser console for errors
- Verify backend API is accessible
- Ensure message input field is detected
- Check Chrome storage: `chrome.storage.local.get(null, console.log)`

## Backend AI Prompt Guidelines

The included backend follows these rules for generating replies:

- **Length**: Keep replies under 20 words
- **Tone**: Casual, friendly, natural
- **Content**: No deep questions, no links (except CTA)
- **CTA Timing**: Only suggest CTA after 2-4 turns
- **CTA Style**: Casual and natural (e.g., "Would love to chat on Instagram! @username")

The backend uses OpenAI's GPT models (default: gpt-3.5-turbo) with optimized prompts to generate short, contextual replies.

## Privacy & Security

- All API calls are made from the content script
- No API keys stored in extension
- Conversation data stored locally in Chrome storage
- No data sent to third parties (only your backend)

## License

MIT License - feel free to modify and use as needed.

## Support

For issues or questions:
1. Check browser console for errors
2. Verify backend API is working
3. Ensure you're on a Match.com conversation page
4. Check that message input field is visible
