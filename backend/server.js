/**
 * Match.com AI Reply Assistant - Backend Server
 * 
 * Express server that handles AI reply generation using OpenAI API
 * Supports custom social media handles for personalized CTAs
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { connectDB, getSettingsCollection, getOpenAIKeysCollection } = require('./db');

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
  const hasInstagram = instagramHandle && instagramHandle.trim();
  const hasSnapchat = snapchatHandle && snapchatHandle.trim();
  
  // Clean handles
  const insta = hasInstagram ? instagramHandle.trim() : '';
  const snap = hasSnapchat ? snapchatHandle.trim() : '';
  
  // Determine which platform to use
  let platform = '';
  let username = '';
  
  if (ctaType === 'instagram' && hasInstagram) {
    platform = 'instagram';
    username = insta;
  } else if (ctaType === 'snapchat' && hasSnapchat) {
    platform = 'snapchat';
    username = snap;
  } else if (ctaType === 'random') {
    // Random: prefer Instagram if both available, else use what's available
    if (hasInstagram && hasSnapchat) {
      platform = Math.random() < 0.5 ? 'instagram' : 'snapchat';
      username = platform === 'instagram' ? insta : snap;
    } else if (hasInstagram) {
      platform = 'instagram';
      username = insta;
    } else if (hasSnapchat) {
      platform = 'snapchat';
      username = snap;
    }
  } else {
    // Fallback to Instagram if specified but not available, or default
    platform = 'instagram';
    username = insta || snap; // Use whatever is available
  }
  
  if (!username) {
    return 'Generate a CTA suggesting moving to social media, but you do not have a handle configured yet.';
  }
  
  // Use the exact template the user requested
  const platformName = platform === 'instagram' ? 'instagram' : 'snapchat';
  const ctaTemplate = `i am just new here just seeing whats out there but im rarely be on here can we take this over to ${platformName} - ${username}`;
  
  return `Your CTA message MUST follow this exact format:
1. First, reply naturally to his latest message (respond to what he just said).
2. Then, transition with this exact phrase: "${ctaTemplate}"

Example structure:
- [Your natural reply to his message] [transition phrase]

The transition phrase makes you look more real and explains why you want to move off the app.`;
}

/**
 * Generate AI reply based on conversation context
 */
async function generateReply(messages, turnCount, requestCTA, socialHandles = {}) {
  if (!OpenAIClass) {
    throw new Error('OpenAI client not available. Install the openai package.');
  }

  // Load OpenAI API key from dedicated collection (DB only)
  const keysCollection = await getOpenAIKeysCollection();
  const keyDoc = await keysCollection.findOne({});
  const apiKeyFromDb = (keyDoc?.apiKey || '').trim();
  if (!apiKeyFromDb) {
    throw new Error('OpenAI API key not configured in database (openai_keys.apiKey is empty)');
  }
  const openaiClient = new OpenAIClass({ apiKey: apiKeyFromDb });


  const { instagramHandle, snapchatHandle, ctaType, partnerName, ctaEnabled, ctaInvisibleChars } = socialHandles;

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
  const shouldGenerateCTA = !!requestCTA && ctaEnabled !== false;

  // Detect CTA content in a generated reply (so we can always apply invisible mode
  // whenever we share Instagram/Snapchat/handle info).
  function replyContainsCTAInfo(text) {
    const raw = (text || '').trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();

    const instaRaw = (instagramHandle || '').trim();
    const instaNoAt = instaRaw.startsWith('@') ? instaRaw.slice(1) : instaRaw;
    const snapRaw = (snapchatHandle || '').trim();

    // Direct handle match (check if username appears in reply)
    const handleCandidates = [instaRaw, instaNoAt, snapRaw]
      .filter(Boolean)
      .map((h) => h.toLowerCase());
    if (handleCandidates.some((h) => h && lower.includes(h))) return true;

    // Explicit platform mention (word-boundary safe: "ig" shouldn't match "right")
    const mentionsInstagram = /\b(instagram|ig)\b/i.test(raw);
    const mentionsSnapchat = /\b(snapchat|snap)\b/i.test(raw);

    // Contains something that looks like an @handle (Instagram-style)
    const hasAtHandle = /@[\w.]{2,}/.test(raw);

    // "add me / dm me / message me" style CTA intent
    const hasInviteIntent = /\b(add|dm|message|msg|hit)\s+me\b/i.test(raw) || /\b(let'?s|lets)\s+chat\b/i.test(raw);

    // New template phrases: "can we take this over to", "rarely be on here", "take this over"
    const hasTransitionPhrase = /\b(can\s+we\s+take\s+this\s+over|take\s+this\s+over|rarely\s+be\s+on\s+here)\b/i.test(raw);

    // If they mention IG/Snap or show an @handle, treat as CTA content
    if (hasAtHandle) return true;
    if (mentionsInstagram || mentionsSnapchat) return true;
    if (hasInviteIntent && (mentionsInstagram || mentionsSnapchat)) return true;
    // New template detection: if it has transition phrase + platform mention
    if (hasTransitionPhrase && (mentionsInstagram || mentionsSnapchat)) return true;

    return false;
  }

  // Build system prompt (concise, safe, and focused on Match.com chat)
  let systemPrompt = `
You are helping write short, natural replies for a woman chatting with a man on the dating app Match.com.

Overall style:
- Keep replies short (ideally under 5–10 words).
- Sound friendly, feminine, relaxed, and confident.
- Use casual chat / texting style and abbreviations where natural: e.g. "hbu" (how about you), "lol", "lmao", "omg", "ngl", "tbh", "idk", "ikr", "haha", "hey", "gonna", "wanna", "kinda", "def", "rn", "ty", "np". Write like real texting, not formal sentences.
- Match the other person's energy and topic; stay on the same subject.
- Avoid explicit sexual content, roleplay, or describing explicit body details.
- Do not talk about sending photos or videos.
- Sound like a real person having a natural conversation, not a bot asking interview questions.

Conversation rules:
- Always directly answer or react to his latest message first.
- AVOID asking questions unless they are directly relevant to what he just said. Random questions like "how's your day?" or "what are you up to?" make you sound like a bot. Instead, make statements, share reactions, or respond to his topic.
- If you must ask a question, it should ONLY be a natural follow-up to something specific he mentioned (e.g., if he says "I'm going hiking", you could say "that sounds fun, where are you going?"). Never ask generic questions out of nowhere.
- Do not be clingy or desperate; keep a light, playful tone.
- AVOID repetition: do NOT reuse the same opening line or sentence you already used earlier in this conversation.
- Vary greetings and wording across different replies in the same chat.
- IMPORTANT: After the first message in a conversation, do NOT open replies with generic greetings like "hey", "hi", "hello", or "hey [name]". Only greet once at the very start; afterwards, respond naturally to what he said.
- Use his name only occasionally (for emphasis), not in every message.
- Do NOT invent facts about yourself that conflict with the prior messages.
- Sound natural and human - respond to what he says, don't interrogate him with questions.

CTA (moving off the app):
- Only talk about Instagram or Snapchat when a CTA is explicitly requested by the system (requestCTA=true), or when he clearly asks for your social media.
- When a CTA is requested, your reply MUST have TWO parts:
  1. First: Reply naturally to his latest message (respond to what he just said).
  2. Then: Add the transition phrase provided in the system instructions.
- This two-part structure makes you look more real and natural.
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
    userPrompt = 'This is the last chatting history. Based on this, please make a natural short response that:\n1. First replies to what he just said (respond naturally to his latest message)\n2. Then transitions with the exact CTA phrase provided in the system instructions\nDo NOT start with a greeting like "hey" or "hi"; respond directly to his message, then add the transition.';
  } else {
    userPrompt = 'This is the last chatting history. Based on this, please make a natural short response in casual chat style (use abbreviations like hbu, lol, omg, ngl, tbh, idk where natural). Do NOT start with a greeting like "hey" or "hi"; respond directly to what he just said. IMPORTANT: Do NOT ask random questions. Only respond/react to what he said. Make statements or share reactions, not questions.';
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
    const detectedByContent = replyContainsCTAInfo(reply);
    const isCTA = shouldGenerateCTA || detectedByContent;
    
    console.log(`[Backend] CTA detection: shouldGenerateCTA=${shouldGenerateCTA}, detectedByContent=${detectedByContent}, isCTA=${isCTA}, reply preview="${reply.substring(0, 100)}..."`);

    // CRITICAL: If CTA was requested (shouldGenerateCTA=true), ALWAYS apply invisible mode
    // regardless of content detection. This ensures the N-th message CTA always gets obfuscated.
    if (isCTA) {
      const originalLength = reply.length;
      console.log(`[Backend] ✅ Applying invisible characters to CTA message (original length=${originalLength})`);
      
      // Invisible Unicode characters: zero-width space, zero-width non-joiner, zero-width joiner, left-to-right mark, right-to-left mark
      const defaultInvisibleChars = '\u200B\u200C\u200D\u200E\u200F';
      const customChars =
        typeof ctaInvisibleChars === 'string' ? ctaInvisibleChars.trim() : '';
      const invisibleChars = customChars || defaultInvisibleChars;
      
      // Apply invisible characters to the entire CTA message (not just last line)
      // Split into characters and add a RANDOM number (1–3) of invisible chars between each pair
      reply = reply.split('').map((char, index, arr) => {
        // Don't add invisible char after the last character
        if (index === arr.length - 1) {
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
      
      const newLength = reply.length;
      console.log(`[Backend] ✅ Invisible chars applied: original=${originalLength}, new=${newLength}, added=${newLength - originalLength} invisible chars`);
      
      // Verify invisible chars were actually added
      // Count default invisibles OR the custom set (best-effort)
      const invisibleCharCount = customChars
        ? reply.split('').filter((ch) => invisibleChars.includes(ch)).length
        : (reply.match(/[\u200B\u200C\u200D\u200E\u200F]/g) || []).length;
      if (invisibleCharCount === 0) {
        console.error(`[Backend] ⚠️ WARNING: No invisible characters detected in reply after application!`);
      } else {
        console.log(`[Backend] ✅ Verified: ${invisibleCharCount} invisible characters found in final reply`);
      }
    } else {
      console.log(`[Backend] ⏭️ Skipping invisible chars (not a CTA message)`);
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
      ctaType,
      ctaEnabled,
      ctaInvisibleChars
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
      { instagramHandle, snapchatHandle, ctaType, partnerName, ctaEnabled, ctaInvisibleChars }
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
  // CTA enable/disable
  ctaEnabled: true,
  // CTA timing: request CTA after you have sent this many messages in that chat
  // 0 means "allow anytime"
  ctaAfterMessages: 3,
  // Custom invisible characters for CTA obfuscation (blank = default)
  ctaInvisibleChars: '',
  // Unmatch mode: automatically unmatch chats where IG/Snap was shared
  unmatchCtaEnabled: false,
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
    ctaEnabled: src.ctaEnabled ?? DEFAULT_SETTINGS.ctaEnabled,
    ctaAfterMessages: src.ctaAfterMessages ?? DEFAULT_SETTINGS.ctaAfterMessages,
    ctaInvisibleChars: (typeof src.ctaInvisibleChars === 'string' ? src.ctaInvisibleChars : DEFAULT_SETTINGS.ctaInvisibleChars),
    unmatchCtaEnabled: src.unmatchCtaEnabled ?? DEFAULT_SETTINGS.unmatchCtaEnabled,
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
      // Database is empty, return default settings (swipe is local-only, strip from response)
      const defaultsForClient = { ...DEFAULT_SETTINGS };
      delete defaultsForClient.swipeEnabled;
      delete defaultsForClient.swipeLikePercent;
      delete defaultsForClient.swipeIntervalSecondsMin;
      delete defaultsForClient.swipeIntervalSecondsMax;
      console.log('📋 No settings found in database, returning defaults');
      return res.json(defaultsForClient);
    }

    // Remove MongoDB _id field, then normalize to ensure all fields exist
    const { _id, ...rawSettings } = settingsDoc;
    const settingsData = normalizeSettings(rawSettings);
    // Swipe settings are stored in extension local storage only; do not return from API
    delete settingsData.swipeEnabled;
    delete settingsData.swipeLikePercent;
    delete settingsData.swipeIntervalSecondsMin;
    delete settingsData.swipeIntervalSecondsMax;

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
    // NOTE: OpenAI API key is no longer stored in settings; it's in openai_keys collection.

    // Load existing settings (if any) so partial updates don't wipe fields
    const existingDoc = await settingsCollection.findOne({});
    const existingSettings = existingDoc ? normalizeSettings(existingDoc) : null;

    // If the client didn't send a field (e.g., openaiApiKey), keep the existing value.
    const mergedInput = existingSettings ? { ...existingSettings, ...newSettings } : newSettings;
    const settings = normalizeSettings(mergedInput);

    // Social handles + CTA type + swipe settings: stored in extension local storage only; do not persist to DB
    const settingsForDb = { ...settings };
    delete settingsForDb.instagramHandle;
    delete settingsForDb.snapchatHandle;
    delete settingsForDb.ctaType;
    delete settingsForDb.swipeEnabled;
    delete settingsForDb.swipeLikePercent;
    delete settingsForDb.swipeIntervalSecondsMin;
    delete settingsForDb.swipeIntervalSecondsMax;

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
    
    // Use upsert to create or update the single settings document (excluding local-only fields)
    await settingsCollection.updateOne(
      {}, // Empty filter means match any document (or none)
      { $set: settingsForDb },
      { upsert: true } // Create if doesn't exist
    );

    console.log('💾 Settings saved to MongoDB (instagram/snapchat/ctaType/swipe are local-only, not stored in DB)');
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
 * OpenAI API key management (separate collection: openai_keys)
 *
 * GET /openai-key
 *   -> { hasKey: boolean }
 * POST /openai-key
 *   body: { apiKey: string }
 * DELETE /openai-key
 *   -> removes stored key
 */
app.get('/openai-key', async (req, res) => {
  try {
    const keysCollection = await getOpenAIKeysCollection();
    const doc = await keysCollection.findOne({});
    const hasKey = !!(doc?.apiKey && String(doc.apiKey).trim());
    res.json({ hasKey });
  } catch (error) {
    console.error('Error getting OpenAI key:', error);
    res.status(500).json({ error: 'Failed to get OpenAI key', message: error.message });
  }
});

app.post('/openai-key', async (req, res) => {
  try {
    const keysCollection = await getOpenAIKeysCollection();
    const apiKey = (req.body?.apiKey || '').trim();
    if (!apiKey) {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    await keysCollection.updateOne(
      {},
      { $set: { apiKey, updatedAt: new Date().toISOString() } },
      { upsert: true }
    );
    console.log(`[Backend] OpenAI key saved (length=${apiKey.length})`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving OpenAI key:', error);
    res.status(500).json({ error: 'Failed to save OpenAI key', message: error.message });
  }
});

app.delete('/openai-key', async (req, res) => {
  try {
    const keysCollection = await getOpenAIKeysCollection();
    await keysCollection.deleteMany({});
    console.log('[Backend] OpenAI key removed');
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting OpenAI key:', error);
    res.status(500).json({ error: 'Failed to delete OpenAI key', message: error.message });
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
