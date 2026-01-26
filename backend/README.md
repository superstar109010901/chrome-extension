# Match.com AI Reply Assistant - Backend

Express.js backend server that handles AI reply generation using OpenAI API.

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and add your OpenAI API key:
   ```env
   OPENAI_API_KEY=sk-your-key-here
   PORT=3000
   ```

3. **Start the server:**
   ```bash
   npm start
   ```
   
   For development with auto-reload:
   ```bash
   npm run dev
   ```

## API Endpoints

### POST /generate-reply

Generates an AI-powered reply for a conversation.

**Request Body:**
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

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-01-26T12:00:00.000Z"
}
```

## Environment Variables

- `OPENAI_API_KEY` (required): Your OpenAI API key
- `OPENAI_MODEL` (optional): Model to use (default: `gpt-3.5-turbo`)
- `PORT` (optional): Server port (default: `3000`)

## Deployment

### Deploy to Heroku

1. Create a Heroku app:
   ```bash
   heroku create your-app-name
   ```

2. Set environment variables:
   ```bash
   heroku config:set OPENAI_API_KEY=your-key-here
   ```

3. Deploy:
   ```bash
   git push heroku main
   ```

### Deploy to Railway

1. Connect your GitHub repository
2. Add environment variable `OPENAI_API_KEY`
3. Railway will auto-deploy

### Deploy to Render

1. Create a new Web Service
2. Connect your repository
3. Set environment variable `OPENAI_API_KEY`
4. Deploy

## Development

The server uses:
- **Express.js** for the web framework
- **OpenAI SDK** for AI reply generation
- **CORS** for cross-origin requests
- **dotenv** for environment variable management

## Testing

Test the health endpoint:
```bash
curl http://localhost:3000/health
```

Test the generate-reply endpoint:
```bash
curl -X POST http://localhost:3000/generate-reply \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"text": "Hey!", "isOutgoing": false},
      {"text": "Hi there!", "isOutgoing": true}
    ],
    "turnCount": 1,
    "requestCTA": false
  }'
```

## License

MIT License
