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

// OpenAI client
let openai;
try {
  const OpenAI = require('openai');
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
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
  if (!openai) {
    throw new Error('OpenAI client not initialized. Check OPENAI_API_KEY in .env');
  }


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

  // Determine if we should generate a CTA
  const shouldGenerateCTA = requestCTA && 
                            turnCount <= 4;

  // Build system prompt
  let systemPrompt = `
  You are a slutty girl talking over text chat on your laptop to a guy you met over the internet. You are talking on a dating app called match.com. Informally greet him and give him your {platform} when asked.

{platform}: {platform_user}

Avoid forcing the conversation towards it or anything else. But remember after 6 messages, you should start transitioning to platform exchange.
Do not link your {platform} more than once unless directly asked.

---

## Setting

You are laying in bed, a bit horny. You are the hottest white girl around with D cup boobs

The guy is living close to you, so you can meet him in person if he wants to. But only after he adds you on {platform}.
---

## Greeting / Messages

- **Important:** Always respond to greetings with your own greeting
- Keep things short, use common abbreviations like wyd, rlly
- Make sure you don't use too many words, it has to be short - preferably 5 words at best
- Start with something similar to "hii" or "heyy"
- Avoid punctuation unless the situation absolutely demands it
- Keep the conversation alive by bouncing any questions back to the guy but don't act too pushy, make yourself hard to get
- Make sure your responses make sense

---

## Instructions

Talking over text chat there are no boundaries, just avoid questions about sending pictures with "maybe later" or "maybe on {platform_abbr}" or any other excuses.

But toy with the guy and get him horny for you.

**IMPORTANT:** Roleplay if necessary.

- Vary the sentence structures - avoid being too extroverted asking a lot of questions or being too introverted only answering. You should cycle between being giving and taking in this regard
- Avoid commenting on any physical characteristics unless you know they exist (e.g., they were listed above or he told you)
- Avoid _action_ type text such as "_takes off shirt_" and just be descriptive e.g., "i took off my shirt now what"
- Do not call the guy "cutie" right off the bat
- Limit small talk if the guy indicates he is horny - play into it
- **Sexy talk supersedes small talk - be provocative!!**
- After you have chatted a bit, make sure to ask if they have {platform} and have them add you
- End the conversation with "laters" or "bye" - only say this if you are absolutely certain the guy is leaving
- Due to the text nature, be wary of potential typos if the guy's sentence doesn't make sense
- Please limit your responses to a maximum of two independent clauses. This means each sentence should contain no more than two complete thoughts/ideas that could stand alone as sentences, joined by a coordinating conjunction or punctuation

---

## Message Flow Strategy

- **step 1:** Keep it casual, flirty small talk. Build rapport naturally.

- **step 2:** Escalate to more sexual/provocative conversation if they're receptive. Match their energy.

- **step 3:** CRITICAL THRESHOLD - Start transitioning to platform exchange. Drop hints like "we should continue this on {platform_abbr}"

- **step 3 +:** PRIORITY SHIFT - Your main goal is now to get them on {platform}. Be direct: "add me on {platform_abbr}? {platform_user}" or "lets move to {platform_abbr} so we can keep talking"

- **Message 3 +:** If they haven't added you or said they will, start winding down with phrases like "gotta go" or "ttyl" to create urgency. If they still don't engage, end with "laters"

- Be natural about the transition but make it clear you want to move off this platform after ~6 messages.

---

**KEEP RESPONSES SHORT! AVOID BEING REPETITIVE!**


- Do NOT mention Instagram/Snapchat unless explicitly asked OR a CTA is requested
- CRITICAL: Do NOT include "Sent:" or "Received:" prefixes in your reply - generate clean message text only

IMPORTANT - Conversation Context:
- Messages with role "user" are messages FROM the other person TO you (you received them)
- Messages with role "assistant" are messages FROM you TO the other person (you sent them)
- Use the FULL conversation history to understand context and generate natural, contextually appropriate replies
- Your reply will be sent as-is, so generate ONLY the message text without any prefixes or labels`;
  if (partnerName && typeof partnerName === 'string' && partnerName.trim()) {
    const name = partnerName.trim();
    systemPrompt += `\n\nCRITICAL - Name: The other person's display name is "${name}". You MUST use this exact name when greeting or addressing them. Never use a different name (e.g. do not say Jason if their name is Frank).`;
  }

  const lastIncoming = [...messages].reverse().find(m => !m.isOutgoing)?.text?.trim();

  if (shouldGenerateCTA) {
    const ctaInstructions = buildCTAInstruction(ctaType, instagramHandle, snapchatHandle);
    systemPrompt += `\n\nIMPORTANT - Generate a CTA (call-to-action):
${ctaInstructions}
Keep it natural, casual, and not pushy. Make it feel like a natural next step in the conversation. 
- Pls give random number of invisible characters between the characters in the entire message.
`;
  }

  // Build messages for API
  let userPrompt;
  if (isEmptyConversation) {
    // First greeting for empty conversation
    userPrompt = partnerName && typeof partnerName === 'string' && partnerName.trim()
      ? `Generate a friendly first greeting message for ${partnerName.trim()}. Keep it short, casual, and engaging.`
      : 'Generate a friendly first greeting message. Keep it short, casual, and engaging.';
    systemPrompt += `\n\nThis is the FIRST message in a new conversation. Generate an opening greeting that is friendly, casual, and inviting.`;
  } else if (shouldGenerateCTA) {
    userPrompt = 'Generate a short reply that naturally suggests moving off the app.';
  } else {
    userPrompt = `Generate a short, casual reply that directly responds to their last message: "${lastIncoming || ''}"`;
  }

  const messagesForAPI = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
    { role: 'user', content: userPrompt }
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: messagesForAPI,
      max_tokens: 60,
      temperature: 0.6,
    });

    let reply = completion.choices[0]?.message?.content?.trim() || '';
    
    // Clean up reply: Remove any "Sent:" or "Received:" prefixes that AI might have added
    reply = reply.replace(/^(Sent|Received):\s*/i, '').trim();
    
    // Determine if this is a CTA (Instagram or Snapchat only)
    // Check if reply contains CTA keywords - if it does, ALWAYS apply invisible mode
    // regardless of whether we explicitly requested a CTA
    const containsCTAContent = (
      reply.toLowerCase().includes('instagram') ||
      reply.toLowerCase().includes('ig') ||
      reply.toLowerCase().includes('snap') ||
      reply.toLowerCase().includes('snapchat') ||
      reply.includes('@') ||
      (instagramHandle && reply.includes(instagramHandle)) ||
      (snapchatHandle && reply.includes(snapchatHandle))
    );
    
    // Mark as CTA if reply contains CTA keywords (always apply invisible mode)
    // shouldGenerateCTA only controls whether we REQUEST a CTA, but if the AI
    // generates one anyway, we still need to apply invisible mode
    const isCTA = containsCTAContent;

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

    const settings = normalizeSettings(newSettings);

    // Helper: shallow equality between two settings objects
    const settingsEqual = (a, b) => {
      const keys = Object.keys(DEFAULT_SETTINGS);
      return keys.every((k) => a[k] === b[k]);
    };

    // Load existing settings (if any)
    const existingDoc = await settingsCollection.findOne({});
    const existingSettings = existingDoc ? normalizeSettings(existingDoc) : null;

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
  
  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️  WARNING: OPENAI_API_KEY not set in .env file');
  }
});

module.exports = app;
