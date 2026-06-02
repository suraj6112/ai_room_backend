const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');

// Lazy-initialized clients
let openaiClient = null;
let googleAI = null;
let anthropicClient = null;

function getOpenAIClient() {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

function getGoogleClient() {
  if (!googleAI) {
    googleAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return googleAI;
}

function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// Fallback to these constants if not overridden
const DEFAULT_MODEL = 'gpt-4o';

// Load external Pricing configuration per 1 Million tokens (Input, Output)
const PRICING_MAP = require('./models_pricing.json');

const modelsByProvider = { openai: [], google: [], anthropic: [] };
for (const model of Object.keys(PRICING_MAP)) {
  if (model.startsWith('gpt') || model.startsWith('o1')) modelsByProvider.openai.push(model);
  else if (model.startsWith('gemini')) modelsByProvider.google.push(model);
  else if (model.startsWith('claude')) modelsByProvider.anthropic.push(model);
}

/**
 * Returns the appropriate temperature for a model.
 * Reasoning models (o1, o3, etc.) usually require temperature 1.0 or no temperature.
 */
function getTemperatureForModel(model) {
  if (model.startsWith('o1') || model.startsWith('o3')) return 1.0;
  return 0.0;
}

function generateFallbackChain(primaryProvider, primaryModel) {
  const chain = [];
  
  // 1. Add primary
  chain.push({ provider: primaryProvider, model: primaryModel });

  // 2. Add all other models for primary provider
  let primaryModels = modelsByProvider[primaryProvider] || [];
  
  // Prioritize gpt-4o in the fallback queue
  if (primaryProvider === 'openai') {
    primaryModels = [...primaryModels].sort((a, b) => {
      if (a === 'gpt-4o') return -1;
      if (b === 'gpt-4o') return 1;
      return 0;
    });
  }

  for (const m of primaryModels) {
    if (m !== primaryModel) {
      chain.push({ provider: primaryProvider, model: m });
    }
  }

  // 3. Add secondary provider's models (OpenAI <-> Google)
  const secondaryProvider = primaryProvider === 'openai' ? 'google' : (primaryProvider === 'google' ? 'openai' : 'google');
  const secondaryModels = modelsByProvider[secondaryProvider] || [];
  for (const m of secondaryModels) {
    chain.push({ provider: secondaryProvider, model: m });
  }

  // 4. Add Anthropic as final fallback if not already used
  if (primaryProvider !== 'anthropic' && secondaryProvider !== 'anthropic') {
    const tertiaryModels = modelsByProvider.anthropic || [];
    for (const m of tertiaryModels) {
      chain.push({ provider: 'anthropic', model: m });
    }
  }

  return chain;
}

async function extractTextFromImage(imageBase64, mimeType, prompt, options = {}) {
  const primaryProvider = options.provider || process.env.VISION_PROVIDER || 'openai';
  const primaryModel = options.model || process.env.VISION_MODEL || DEFAULT_MODEL;

  const chain = generateFallbackChain(primaryProvider, primaryModel);
  const journey = [];
  let totalCostEstimate = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (const step of chain) {
    try {
      let result;
      if (step.provider === 'openai') {
        result = await extractWithOpenAI(imageBase64, mimeType, prompt, step.model, options);
      } else if (step.provider === 'google') {
        result = await extractWithGoogle(imageBase64, mimeType, prompt, step.model, options);
      } else if (step.provider === 'anthropic') {
        result = await extractWithAnthropic(imageBase64, mimeType, prompt, step.model, options);
      } else {
        journey.push(`[${step.provider}/${step.model}] Failed: Unknown provider`);
        continue;
      }

      const text = result.text.trim();
      totalCostEstimate += result.costEstimate;
      totalPromptTokens += result.usage.promptTokens;
      totalCompletionTokens += result.usage.completionTokens;

      const lowerText = text.toLowerCase();
      
      // 1. Check for explicit "EMPTY" detection (as instructed by prompt)
      if (text.toUpperCase() === 'EMPTY' || lowerText === '[empty]' || lowerText === 'empty.') {
        journey.push(`[${step.provider}/${step.model}] Success (Identified as Empty)`);
        return {
          text: '[EMPTY PAGE]',
          usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
          costEstimate: totalCostEstimate,
          journey: journey
        };
      }

      // 2. Comprehensive Refusal Detection
      const isConversationalRefusal = 
        lowerText.includes('i can’t reliably extract') ||
        lowerText.includes('i can\'t reliably extract') ||
        lowerText.includes('i cannot reliably extract') ||
        lowerText.includes('too small/low-resolution') ||
        lowerText.includes('please provide a clearer image') ||
        lowerText.includes('i am unable to extract') ||
        lowerText.includes('i\'m sorry') ||
        lowerText.includes('i am sorry') ||
        lowerText.includes('cannot extract text') ||
        lowerText.includes('no text found') ||
        lowerText.includes('is blank') ||
        lowerText.includes('image is empty') ||
        (text.length < 500 && (
          lowerText.includes('too small') || 
          lowerText.includes('low-resolution') || 
          lowerText.includes('cannot read') || 
          lowerText.includes('unable to extract') ||
          lowerText.includes('too blurry') ||
          lowerText.includes('cannot see') ||
          lowerText.includes('sorry, i can')
        ));

      if (text.length < 5 || isConversationalRefusal) {
        journey.push(`[${step.provider}/${step.model}] Refused (empty or conversational)`);
        continue; // Try next in chain
      }

      journey.push(`[${step.provider}/${step.model}] Success`);
      return {
        text: text,
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
        costEstimate: totalCostEstimate,
        journey: journey
      };

    } catch (error) {
      journey.push(`[${step.provider}/${step.model}] Failed: ${error.message}`);
      continue;
    }
  }

  throw new Error(`All providers failed. Journey:\n  ` + journey.join('\n  '));
}

async function extractWithOpenAI(imageBase64, mimeType, prompt, model, options) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY Missing');
  }
  const openai = getOpenAIClient();
  const content = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' } }
  ];

  const maxTokens = options.maxTokens || 4096;

  try {
    const response = await openai.chat.completions.create({
      model: model,
      messages: [{ role: 'user', content }],
      max_completion_tokens: maxTokens,
      temperature: getTemperatureForModel(model)
    });

    const markdown = response.choices[0]?.message?.content || '';
    const promptTokens = response.usage?.prompt_tokens || 0;
    const completionTokens = response.usage?.completion_tokens || 0;

    return {
      text: markdown,
      usage: { promptTokens, completionTokens },
      costEstimate: calculateActualCost(model, promptTokens, completionTokens)
    };
  } catch (error) {
    let simpleMessage = error.message;
    if (error.status === 404) simpleMessage = 'Model Not Found';
    if (error.status === 401) simpleMessage = 'Invalid API Key';
    if (error.status === 429) simpleMessage = 'Rate Limit Exceeded';
    if (error.status >= 500) simpleMessage = 'AI Provider Busy';

    throw new Error(simpleMessage);
  }
}

async function extractWithGoogle(imageBase64, mimeType, prompt, modelName, options) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY Missing');
  }

  try {
    const genAI = getGoogleClient();
    const model = genAI.getGenerativeModel({ 
      model: modelName,
      generationConfig: { temperature: getTemperatureForModel(modelName) }
    });

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: imageBase64,
          mimeType: mimeType
        }
      }
    ]);

    const response = await result.response;
    const text = response.text();

    // Google provides token counts in usageMetadata
    const promptTokens = response.usageMetadata?.promptTokenCount || 0;
    const completionTokens = response.usageMetadata?.candidatesTokenCount || 0;

    return {
      text: text,
      usage: { promptTokens, completionTokens },
      costEstimate: calculateActualCost(modelName, promptTokens, completionTokens)
    };
  } catch (error) {
    let simpleMessage = error.message;
    // Google SDK error objects often have a status property
    const status = error.status || (error.response ? error.response.status : null);

    if (status === 404 || error.message.includes('404')) simpleMessage = 'Model Not Found';
    if (status === 401 || error.message.includes('401')) simpleMessage = 'Invalid API Key';
    if (status === 429 || error.message.includes('429')) simpleMessage = 'Rate Limit Exceeded';
    if (status >= 500 || error.message.includes('500')) simpleMessage = 'AI Provider Busy';

    throw new Error(simpleMessage);
  }
}

async function extractWithAnthropic(imageBase64, mimeType, prompt, modelName, options) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY Missing');
  }

  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: modelName,
      max_tokens: options.maxTokens || 4096,
      temperature: getTemperatureForModel(modelName),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType,
                data: imageBase64,
              },
            },
            {
              type: "text",
              text: prompt
            }
          ],
        },
      ],
    });

    const text = response.content[0].text;
    const promptTokens = response.usage?.input_tokens || 0;
    const completionTokens = response.usage?.output_tokens || 0;

    return {
      text: text,
      usage: { promptTokens, completionTokens },
      costEstimate: calculateActualCost(modelName, promptTokens, completionTokens)
    };
  } catch (error) {
    let simpleMessage = error.message;
    if (error.status === 404) simpleMessage = 'Model Not Found';
    if (error.status === 401) simpleMessage = 'Invalid API Key';
    if (error.status === 429) simpleMessage = 'Rate Limit Exceeded';
    if (error.status >= 500) simpleMessage = 'AI Provider Busy';

    throw new Error(simpleMessage);
  }
}

function calculateActualCost(model, promptTokens, completionTokens) {
  const pricing = PRICING_MAP[model];
  if (!pricing) {
    console.warn(`[VisionService] Pricing not found for model: ${model}. Cost will be $0.`);
    return 0;
  }

  return (promptTokens * pricing.input / 1000000) + (completionTokens * pricing.output / 1000000);
}

module.exports = {
  extractTextFromImage
};
