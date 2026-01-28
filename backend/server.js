/**
 * Match.com AI Reply Assistant - Backend Server
 * 
 * Express server that handles AI reply generation using OpenAI API
 * Supports custom social media handles for personalized CTAs
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { connectDB, getSettingsCollection } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB on startup
connectDB().catch(console.error);

// OpenAI client (DB-stored key only)
let OpenAIClass = null;
try {
  OpenAIClass = require('openai');
} catch (error) {
  console.warn('OpenAI package not installed. Install with: npm install openai');
}

/**
 * Generate CTA message based on user's preferences and handles
 */
function buildCTAInstruction(ctaType, instagramHandle, snapchatHandle) {
  let ctaInstructions = '';
  
  const hasInstagram = instagramHandle && instagramHandle.trim();
  const hasSnapchat = snapchatHandle && snapchatHandle.trim();
  
  // Clean handles
  const insta = hasInstagram ? instagramHandle.trim() : '';
  const snap = hasSnapchat ? snapchatHandle.trim() : '';
  
  switch (ctaType) {
    case 'instagram':
      ctaInstructions = `Suggest moving to Instagram. Include the handle "${insta}" in a natural way.
Examples:
- "Would love to keep chatting on Instagram! Find me at ${insta}"
- "Let's move to IG! I'm ${insta}"
- "Hit me up on Instagram ${insta}"`;
      break;
      
    case 'snapchat':
      ctaInstructions = `Suggest moving to Snapchat. Include the username "${snap}" naturally.
Examples:
- "Add me on Snap! ${snap}"
- "Let's chat on Snapchat - ${snap}"
- "My snap is ${snap}, add me!"`;
      break;
      
    case 'random':
    default:
      // Build dynamic examples based on what handles are available (Instagram and Snapchat only)
      const examples = [];
      if (hasInstagram) {
        examples.push(`- "Let's chat on Instagram! ${insta}"`);
      }
      if (hasSnapchat) {
        examples.push(`- "Add me on Snap: ${snap}"`);
      }
      
      // If no handles available, default to Instagram placeholder
      if (examples.length === 0) {
        examples.push(`- "Let's chat on Instagram! ${insta}"`);
      }
      
      ctaInstructions = `Suggest moving the conversation off the app to Instagram or Snapchat. Choose one option naturally.
${examples.join('\n')}`;
      break;
  }
  
  return ctaInstructions;
}

/**
 * Generate AI reply based on conversation context
 */
async function generateReply(messages, turnCount, requestCTA, socialHandles = {}) {
  if (!OpenAIClass) {
    throw new Error('OpenAI client not available. Install the openai package.');
  }

  // Load settings to get OpenAI API key (DB preferred)
  const settingsCollection = await getSettingsCollection();
  const settingsDoc = await settingsCollection.findOne({});
  const effectiveSettings = normalizeSettings(settingsDoc || {});
  const apiKeyFromDb = effectiveSettings.openaiApiKey && effectiveSettings.openaiApiKey.trim();
  if (!apiKeyFromDb) {
    throw new Error('OpenAI API key not configured in database (openaiApiKey is empty)');
  }
  const openaiClient = new OpenAIClass({ apiKey: apiKeyFromDb });


  const { instagramHandle, snapchatHandle, ctaType, partnerName } = socialHandles;

  // Check if this is an empty conversation (no messages yet)
  const isEmptyConversation = !messages || messages.length === 0;

  // Build conversation context - use roles to indicate direction (assistant = sent by us, user = received from them)
  // Send FULL chat history so AI has complete context
  // DO NOT add "Sent:" or "Received:" labels to content - AI should generate clean messages without prefixes
  const conversationHistory = messages.map((msg, index) => {
    return {
      role: msg.isOutgoing ? 'assistant' : 'user',
      content: msg.text // Clean message text without direction labels
    };
  });
  
  console.log(`[Backend] Processing ${messages.length} messages (FULL HISTORY)`);
  console.log(`[Backend] Conversation flow: ${messages.map(m => m.isOutgoing ? 'Sent' : 'Received').join(' → ')}`);

  // Determine if we should generate a CTA.
  // The content script already decides WHEN to request a CTA based on
  // the user's "CTA after N messages" setting, so we simply trust
  // requestCTA here.
  const shouldGenerateCTA = !!requestCTA;

  // Detect CTA content in a generated reply (so we can always apply invisible mode
  // whenever we share Instagram/Snapchat/handle info).
  function replyContainsCTAInfo(text) {
    const raw = (text || '').trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();

    const instaRaw = (instagramHandle || '').trim();
    const instaNoAt = instaRaw.startsWith('@') ? instaRaw.slice(1) : instaRaw;
    const snapRaw = (snapchatHandle || '').trim();

    // Direct handle match
    const handleCandidates = [instaRaw, instaNoAt, snapRaw]
      .filter(Boolean)
      .map((h) => h.toLowerCase());
    if (handleCandidates.some((h) => lower.includes(h))) return true;

    // Explicit platform mention (word-boundary safe: "ig" shouldn't match "right")
    const mentionsInstagram = /\b(instagram|ig)\b/i.test(raw);
    const mentionsSnapchat = /\b(snapchat|snap)\b/i.test(raw);

    // Contains something that looks like an @handle (Instagram-style)
    const hasAtHandle = /@[\w.]{2,}/.test(raw);

    // "add me / dm me / message me" style CTA intent
    const hasInviteIntent = /\b(add|dm|message|msg|hit)\s+me\b/i.test(raw) || /\b(let'?s|lets)\s+chat\b/i.test(raw);

    // If they mention IG/Snap or show an @handle, treat as CTA content
    if (hasAtHandle) return true;
    if (mentionsInstagram || mentionsSnapchat) return true;
    if (hasInviteIntent && (mentionsInstagram || mentionsSnapchat)) return true;

    return false;
  }

  // Build system prompt (concise, safe, and focused on Match.com chat)
  let systemPrompt = `
You are helping write short, natural replies for a woman chatting with a man on the dating app Match.com.

Overall style:
- Keep replies very short (ideally under 5–10 words).
- Sound friendly, feminine, relaxed, and confident.
- Use casual texting language (e.g. "hey", "haha", "lol") but do NOT overdo slang.
- Match the other person's energy and topic; stay on the same subject.
- Avoid explicit sexual content, roleplay, or describing explicit body details.
- Do not talk about sending photos or videos.

Conversation rules:
- Always directly answer or react to his latest message first.
- You can ask simple follow‑up questions to keep the chat going.
- Do not be clingy or desperate; keep a light, playful tone.
- AVOID repetition: do NOT reuse the same opening line or sentence you already used earlier in this conversation.
- Vary greetings and wording across different replies in the same chat.
- Do NOT invent facts about yourself that conflict with the prior messages.

CTA (moving off the app):
- Only talk about Instagram or Snapchat when a CTA is explicitly requested by the system (requestCTA=true), or when he clearly asks for your social media.
- When a CTA is requested, you MUST smoothly suggest moving the conversation to ONE platform (Instagram or Snapchat) using the exact handle provided in the system.
- The CTA reply should be a single, short sentence that clearly invites him to add or message you there.
- Keep CTA lines casual and not pushy.

Formatting / technical rules:
- CRITICAL: Do NOT include any prefixes like "Sent:" or "Received:" in your reply.
- Do NOT include quotes around your whole reply.
- Output ONLY the reply text that should be sent in chat (no explanations).

Conversation context:
- Messages with role "user" are messages FROM him TO you.
- Messages with role "assistant" are messages FROM you TO him.
- Use the full conversation history to stay consistent with what has already been said.`;
  if (partnerName && typeof partnerName === 'string' && partnerName.trim()) {
    const name = partnerName.trim();
    systemPrompt += `\n\nCRITICAL - Name: The other person's display name is "${name}". You MUST use this exact name when greeting or addressing them. Never use a different name (e.g. do not say Jason if their name is Frank).`;
  }

  const lastIncoming = [...messages].reverse().find(m => !m.isOutgoing)?.text?.trim();

  // Help the model avoid repeating itself by explicitly showing recent
  // assistant messages and forbidding reusing them.
  const recentAssistantMessages = messages
    .filter(m => m.isOutgoing && m.text)
    .map(m => m.text.trim())
    .filter(Boolean)
    .slice(-3);

  let recentAssistantNormalized = [];
  if (recentAssistantMessages.length > 0) {
    const bullets = recentAssistantMessages
      .map(t => `- "${t.substring(0, 80)}"${t.length > 80 ? '...' : ''}`)
      .join('\n');
    systemPrompt += `\n\nRecent replies you ALREADY used in this conversation:\n${bullets}\nYou MUST NOT reuse these sentences or very similar wording. Always generate a fresh reply with different phrasing, while staying consistent with the same meaning and context.`;
    recentAssistantNormalized = recentAssistantMessages.map((t) =>
      t
        .toLowerCase()
        .replace(/[\s\p{P}]+/gu, ' ')
        .trim()
    );
  }

  if (shouldGenerateCTA) {
    const ctaInstructions = buildCTAInstruction(ctaType, instagramHandle, snapchatHandle);
    systemPrompt += `\n\nIMPORTANT - Generate a CTA (call-to-action):
${ctaInstructions}
Keep it natural, casual, and not pushy. Make it feel like a natural next step in the conversation.`;
  }

  // Build messages for API
  let userPrompt;
  if (isEmptyConversation) {
    // First greeting for empty conversation
    userPrompt = partnerName && typeof partnerName === 'string' && partnerName.trim()
      ? `This is a new conversation with ${partnerName.trim()}. Please make a natural, short first greeting message.`
      : 'This is a new conversation. Please make a natural, short first greeting message.';
    systemPrompt += `\n\nThis is the FIRST message in a new conversation. Generate an opening greeting that is friendly, casual, and inviting.`;
  } else if (shouldGenerateCTA) {
    userPrompt = 'This is the last chatting history. Based on this, please make a natural short response that also naturally suggests moving this chat to the requested platform (Instagram or Snapchat) using the handle provided in the system.';
  } else {
    userPrompt = 'This is the last chatting history. Based on this, please make a natural short response.';
  }

  const baseMessagesForAPI = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
    { role: 'user', content: userPrompt }
  ];

  // Helper to normalize reply text for comparison
  const normalizeText = (text) =>
    (text || '')
      .toLowerCase()
      .replace(/[\s\p{P}]+/gu, ' ')
      .trim();

  try {
    // First attempt
    const completion = await openaiClient.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: baseMessagesForAPI,
      max_tokens: 60,
      temperature: 0.6,
      // Encourage the model to avoid repeating the same wording
      frequency_penalty: 0.8,
      presence_penalty: 0.2
    });

    let reply = completion.choices[0]?.message?.content?.trim() || '';
    
    // Clean up reply: Remove any "Sent:" or "Received:" prefixes that AI might have added
    reply = reply.replace(/^(Sent|Received):\s*/i, '').trim();

    // If reply is effectively the same as a recent assistant message,
    // ask the model once more to rewrite it with different wording.
    const normalizedReply = normalizeText(reply);
    if (
      normalizedReply &&
      recentAssistantNormalized.length > 0 &&
      recentAssistantNormalized.includes(normalizedReply)
    ) {
      console.log(
        '[Backend] Detected duplicate-style reply compared to recent assistant messages. Requesting a rewritten variant.'
      );
      const dedupSystemPrompt =
        systemPrompt +
        '\n\nYour last attempt repeated wording you already used. Generate a NEW reply that keeps the same intent but uses clearly different phrasing. Do NOT reuse any of the sentences listed above or close variants.';
      const dedupMessagesForAPI = [
        { role: 'system', content: dedupSystemPrompt },
        ...conversationHistory,
        { role: 'user', content: userPrompt }
      ];

      const completion2 = await openaiClient.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
        messages: dedupMessagesForAPI,
        max_tokens: 60,
        temperature: 0.8,
        frequency_penalty: 1.0,
        presence_penalty: 0.4
      });

      const second = completion2.choices[0]?.message?.content?.trim() || '';
      if (second) {
        reply = second.replace(/^(Sent|Received):\s*/i, '').trim();
      }
    }
    
    // If we share CTA info (IG/Snap/handle), ALWAYS apply invisible mode.
    // This also covers the N-th message CTA timing because shouldGenerateCTA
    // will be true at that moment.
    const isCTA = shouldGenerateCTA || replyContainsCTAInfo(reply);

    // If this is a CTA, add invisible Unicode characters between characters in the entire message.
    // This makes the CTA appear corrupted/invisible (invisible mode).
    if (isCTA) {
      // Invisible Unicode characters: zero-width space, zero-width non-joiner, zero-width joiner, left-to-right mark, right-to-left mark
      const invisibleChars = '\u200B\u200C\u200D\u200E\u200F';
      
      // Apply invisible characters to the entire CTA message (not just last line)
      // Split into characters and add a RANDOM number (1–3) of invisible chars between each pair
      reply = reply.split('').map((char, index) => {
        // Don't add invisible char after the last character
        if (index === reply.length - 1) {
          return char;
        }
        // Add between 1 and 3 random invisible chars between each character
        const count = 1 + Math.floor(Math.random() * 3); // 1, 2, or 3
        let buffer = char;
        for (let i = 0; i < count; i++) {
          const randomInvisible = invisibleChars.charAt(
            Math.floor(Math.random() * invisibleChars.length)
          );
          buffer += randomInvisible;
        }
        return buffer;
      }).join('');
    }

    return {
      reply: reply,
      isCTA: isCTA
    };
  } catch (error) {
    console.error('OpenAI API error:', error);
    throw new Error(`Failed to generate reply: ${error.message}`);
  }
}

/**
 * POST /generate-reply
 * 
 * Request body:
 * {
 *   messages: [{ text: string, isOutgoing: boolean, direction: 'sent' | 'received' }],
 *   turnCount: number,
 *   requestCTA: boolean,
 *   partnerName: string (optional),
 *   instagramHandle: string (optional),
 *   snapchatHandle: string (optional),
 *   ctaType: 'instagram' | 'snapchat' | 'random' (optional)
 * }
 * 
 * Response:
 * {
 *   reply: string,
 *   isCTA: boolean
 * }
 */
app.post('/generate-reply', async (req, res) => {
  try {
    const { 
      messages, 
      turnCount, 
      requestCTA,
      partnerName,
      instagramHandle,
      snapchatHandle,
      ctaType
    } = req.body;

    // Validation
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ 
        error: 'Invalid request: messages array is required' 
      });
    }
    
    // Allow empty messages array for first greeting (new conversation)
    // Empty array means no messages yet - we'll generate a greeting

    if (typeof turnCount !== 'number' || turnCount < 0) {
      return res.status(400).json({ 
        error: 'Invalid request: turnCount must be a non-negative number' 
      });
    }

    // Generate reply with social handles and partner name
    const result = await generateReply(
      messages, 
      turnCount, 
      requestCTA || false,
      { instagramHandle, snapchatHandle, ctaType, partnerName }
    );

    res.json(result);
  } catch (error) {
    console.error('Error in /generate-reply:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

/**
 * Default settings structure
 */
const DEFAULT_SETTINGS = {
  autoMode: false,
  autoSend: true,
  replyDelayMin: 3,
  replyDelayMax: 8,
  chatSwitchDelay: 30,
  randomBreakMode: false,
  breakDurationMin: 5,
  breakDurationMax: 15,
  breakIntervalMin: 45,
  breakIntervalMax: 75,
  instagramHandle: '',
  snapchatHandle: '',
  ctaType: 'instagram',
  // CTA timing: request CTA after you have sent this many messages in that chat
  // 0 means "allow anytime"
  ctaAfterMessages: 3,
  // OpenAI API key (stored in DB; used in preference to env)
  openaiApiKey: '',
  // Swipe settings
  swipeEnabled: false,
  swipeLikePercent: 50,
  swipeIntervalSecondsMin: 4,
  swipeIntervalSecondsMax: 8
};

/**
 * Normalize incoming/settings objects against defaults.
 * Also handles legacy fields (e.g. old single swipeIntervalSeconds).
 */
const normalizeSettings = (src = {}) => {
  // Backward-compat: if old single swipeIntervalSeconds exists, map it into min/max
  let swipeIntervalSecondsMin = src.swipeIntervalSecondsMin;
  let swipeIntervalSecondsMax = src.swipeIntervalSecondsMax;
  if ((swipeIntervalSecondsMin == null || swipeIntervalSecondsMax == null) && src.swipeIntervalSeconds != null) {
    const base = Number(src.swipeIntervalSeconds) || DEFAULT_SETTINGS.swipeIntervalSecondsMin;
    swipeIntervalSecondsMin = swipeIntervalSecondsMin ?? Math.max(2, base - 2);
    swipeIntervalSecondsMax = swipeIntervalSecondsMax ?? Math.min(60, base + 2);
  }

  const openaiApiKeyCandidate =
    (typeof src.openaiApiKey === 'string' ? src.openaiApiKey : undefined) ??
    (typeof src.open_ai_api_key === 'string' ? src.open_ai_api_key : undefined);

  return {
    autoMode: src.autoMode ?? DEFAULT_SETTINGS.autoMode,
    autoSend: src.autoSend ?? DEFAULT_SETTINGS.autoSend,
    replyDelayMin: src.replyDelayMin ?? DEFAULT_SETTINGS.replyDelayMin,
    replyDelayMax: src.replyDelayMax ?? DEFAULT_SETTINGS.replyDelayMax,
    chatSwitchDelay: src.chatSwitchDelay ?? DEFAULT_SETTINGS.chatSwitchDelay,
    randomBreakMode: src.randomBreakMode ?? DEFAULT_SETTINGS.randomBreakMode,
    breakDurationMin: src.breakDurationMin ?? DEFAULT_SETTINGS.breakDurationMin,
    breakDurationMax: src.breakDurationMax ?? DEFAULT_SETTINGS.breakDurationMax,
    breakIntervalMin: src.breakIntervalMin ?? DEFAULT_SETTINGS.breakIntervalMin,
    breakIntervalMax: src.breakIntervalMax ?? DEFAULT_SETTINGS.breakIntervalMax,
    instagramHandle: src.instagramHandle ?? DEFAULT_SETTINGS.instagramHandle,
    snapchatHandle: src.snapchatHandle ?? DEFAULT_SETTINGS.snapchatHandle,
    ctaType: src.ctaType ?? DEFAULT_SETTINGS.ctaType,
    ctaAfterMessages: src.ctaAfterMessages ?? DEFAULT_SETTINGS.ctaAfterMessages,
    // Accept both camelCase and snake_case field names from clients/DB.
    openaiApiKey: openaiApiKeyCandidate ?? DEFAULT_SETTINGS.openaiApiKey,
    swipeEnabled: src.swipeEnabled ?? DEFAULT_SETTINGS.swipeEnabled,
    swipeLikePercent: src.swipeLikePercent ?? DEFAULT_SETTINGS.swipeLikePercent,
    swipeIntervalSecondsMin: swipeIntervalSecondsMin ?? DEFAULT_SETTINGS.swipeIntervalSecondsMin,
    swipeIntervalSecondsMax: swipeIntervalSecondsMax ?? DEFAULT_SETTINGS.swipeIntervalSecondsMax
  };
};

/**
 * GET /settings
 * Get extension settings from MongoDB
 * Returns default settings if database is empty
 */
app.get('/settings', async (req, res) => {
  try {
    const settingsCollection = await getSettingsCollection();

    // Get settings (there should only be one document)
    const settingsDoc = await settingsCollection.findOne({});

    if (!settingsDoc) {
      // Database is empty, return default settings
      console.log('📋 No settings found in database, returning defaults');
      return res.json(DEFAULT_SETTINGS);
    }

    // Remove MongoDB _id field, then normalize to ensure all fields (including new swipe ones) exist
    const { _id, ...rawSettings } = settingsDoc;
    const settingsData = normalizeSettings(rawSettings);

    res.json(settingsData);
    console.log('💾 Settings fetched from MongoDB (normalized):', settingsData);
  } catch (error) {
    console.error('Error getting settings:', error);
    res.status(500).json({ 
      error: 'Failed to get settings',
      message: error.message 
    });
  }
});

/**
 * POST /settings
 * Save extension settings to MongoDB
 * Creates or updates the single settings document
 */
app.post('/settings', async (req, res) => {
  try {
    const settingsCollection = await getSettingsCollection();
    const newSettings = req.body;
    const incomingKey =
      (typeof newSettings.openaiApiKey === 'string' ? newSettings.openaiApiKey : undefined) ??
      (typeof newSettings.open_ai_api_key === 'string' ? newSettings.open_ai_api_key : undefined);
    if (typeof incomingKey === 'string') {
      console.log(`[Backend] Received openaiApiKey update (length=${incomingKey.trim().length})`);
    }

    // Load existing settings (if any) so partial updates don't wipe fields
    const existingDoc = await settingsCollection.findOne({});
    const existingSettings = existingDoc ? normalizeSettings(existingDoc) : null;

    // If the client didn't send a field (e.g., openaiApiKey), keep the existing value.
    const mergedInput = existingSettings ? { ...existingSettings, ...newSettings } : newSettings;
    const settings = normalizeSettings(mergedInput);

    // Helper: shallow equality between two settings objects
    const settingsEqual = (a, b) => {
      const keys = Object.keys(DEFAULT_SETTINGS);
      return keys.every((k) => a[k] === b[k]);
    };

    // PROTECTION:
    // If DB already has non-default settings and the incoming payload is *exactly* the defaults,
    // treat this as a bad/automatic overwrite attempt and KEEP the original values.
    if (existingSettings && settingsEqual(settings, DEFAULT_SETTINGS) && !settingsEqual(existingSettings, DEFAULT_SETTINGS)) {
      console.log('⚠️  Ignoring default settings overwrite; keeping existing MongoDB settings');
      return res.json({ success: true, settings: existingSettings });
    }
    
    // Use upsert to create or update the single settings document
    await settingsCollection.updateOne(
      {}, // Empty filter means match any document (or none)
      { $set: settings },
      { upsert: true } // Create if doesn't exist
    );
    
    console.log('💾 Settings saved to MongoDB');
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Error saving settings:', error);
    res.status(500).json({ 
      error: 'Failed to save settings',
      message: error.message 
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    features: {
      autoMode: true,
      customCTA: true,
      mongodb: true
    }
  });
});

/**
 * Root endpoint
 */
app.get('/', (req, res) => {
  res.json({ 
    message: 'Match.com AI Reply Assistant API',
    version: '2.0.0',
    endpoints: {
      'POST /generate-reply': 'Generate AI reply for conversation',
      'GET /settings': 'Get extension settings from MongoDB',
      'POST /settings': 'Save extension settings to MongoDB',
      'GET /health': 'Health check'
    },
    features: [
      'Auto/Manual mode support',
      'Custom Instagram handle for CTA',
      'Custom Snapchat handle for CTA',
      'Instagram/Snapchat CTA options'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Match.com AI Reply Assistant API v2.0 running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`✨ Features: Auto mode, Custom social handles for CTA`);
});

module.exports = app;
