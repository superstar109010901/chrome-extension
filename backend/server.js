/**
 * Match.com AI Reply Assistant - Backend Server
 * 
 * Express server that handles AI reply generation using OpenAI API
 * Supports custom social media handles for personalized CTAs
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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
  const insta = hasInstagram ? instagramHandle.trim() : '@myinstagram';
  const snap = hasSnapchat ? snapchatHandle.trim() : 'mysnapchat';
  
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
      
    case 'coffee':
      ctaInstructions = `Suggest meeting for coffee or drinks casually.
Examples:
- "Want to grab coffee sometime this week?"
- "We should meet up for drinks!"
- "How about coffee this weekend?"`;
      break;
      
    case 'random':
    default:
      // Build dynamic examples based on what handles are available
      const examples = [];
      if (hasInstagram) {
        examples.push(`- "Let's chat on Instagram! ${insta}"`);
      }
      if (hasSnapchat) {
        examples.push(`- "Add me on Snap: ${snap}"`);
      }
      examples.push(`- "Want to grab coffee this weekend?"`);
      
      ctaInstructions = `Suggest moving the conversation off the app. Choose one option naturally.
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

  // Build conversation context
  const conversationHistory = messages.map(msg => {
    return {
      role: msg.isOutgoing ? 'assistant' : 'user',
      content: msg.text
    };
  });

  // Determine if we should generate a CTA
  const shouldGenerateCTA = requestCTA && 
                            turnCount >= 2 && 
                            turnCount <= 4;

  // Build system prompt
  let systemPrompt = `You are generating short, casual replies for a dating app conversation. 
Rules:
- Keep replies under 20 words
- Use a casual, friendly, natural tone
- No deep or philosophical questions
- No external links or URLs
- Be conversational and light-hearted
- Match the energy and style of the conversation
- Sound human and natural, not robotic
- Reply MUST directly address the other person's most recent message/topic
- Do NOT introduce unrelated topics or random activities
- Do NOT mention Instagram/Snap/coffee unless explicitly asked OR a CTA is requested`;
  if (partnerName && typeof partnerName === 'string' && partnerName.trim()) {
    const name = partnerName.trim();
    systemPrompt += `\n\nCRITICAL - Name: The other person's display name is "${name}". You MUST use this exact name when greeting or addressing them. Never use a different name (e.g. do not say Jason if their name is Frank).`;
  }

  const lastIncoming = [...messages].reverse().find(m => !m.isOutgoing)?.text?.trim();

  if (shouldGenerateCTA) {
    const ctaInstructions = buildCTAInstruction(ctaType, instagramHandle, snapchatHandle);
    systemPrompt += `\n\nIMPORTANT - Generate a CTA (call-to-action):
${ctaInstructions}
Keep it natural, casual, and not pushy. Make it feel like a natural next step in the conversation.`;
  }

  // Build messages for API
  const messagesForAPI = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
    { role: 'user', content: shouldGenerateCTA 
      ? 'Generate a short reply that naturally suggests moving off the app.'
      : `Generate a short, casual reply that directly responds to their last message: "${lastIncoming || ''}"` 
    }
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: messagesForAPI,
      max_tokens: 60,
      temperature: 0.6,
    });

    let reply = completion.choices[0]?.message?.content?.trim() || '';
    
    // Determine if this is a CTA
    const isCTA = shouldGenerateCTA && (
      reply.toLowerCase().includes('instagram') ||
      reply.toLowerCase().includes('snap') ||
      reply.toLowerCase().includes('coffee') ||
      reply.toLowerCase().includes('meet') ||
      reply.toLowerCase().includes('grab') ||
      reply.toLowerCase().includes('drinks') ||
      reply.includes('@') ||
      (instagramHandle && reply.includes(instagramHandle)) ||
      (snapchatHandle && reply.includes(snapchatHandle))
    );

    // If this is a CTA, add invisible Unicode characters between every character in the entire message
    // This makes the CTA appear corrupted/invisible (invisible mode)
    if (isCTA) {
      // Invisible Unicode characters: zero-width space, zero-width non-joiner, zero-width joiner, left-to-right mark, right-to-left mark
      const invisibleChars = '\u200B\u200C\u200D\u200E\u200F';
      
      // Apply invisible characters to the entire CTA message (not just last line)
      // Split into characters and add invisible char between each character
      reply = reply.split('').map((char, index) => {
        // Don't add invisible char after the last character
        if (index === reply.length - 1) {
          return char;
        }
        // Add random invisible char between each character
        const randomInvisible = invisibleChars.charAt(Math.floor(Math.random() * invisibleChars.length));
        return char + randomInvisible;
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
 *   messages: [{ text: string, isOutgoing: boolean }],
 *   turnCount: number,
 *   requestCTA: boolean,
 *   instagramHandle: string (optional),
 *   snapchatHandle: string (optional),
 *   ctaType: 'instagram' | 'snapchat' | 'coffee' | 'random' (optional)
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
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ 
        error: 'Invalid request: messages array is required' 
      });
    }

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
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    features: {
      autoMode: true,
      customCTA: true
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
      'GET /health': 'Health check'
    },
    features: [
      'Auto/Manual mode support',
      'Custom Instagram handle for CTA',
      'Custom Snapchat handle for CTA',
      'Coffee/meetup CTA option'
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
