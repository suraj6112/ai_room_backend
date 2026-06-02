const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');

// Lazy-initialized clients
let openaiClient = null;
let googleAI = null;
let anthropicClient = null;

function getOpenAIClient() {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

function getGoogleClient() {
  if (!googleAI) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
    googleAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return googleAI;
}

function getAnthropicClient() {
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// Pricing configuration
const PRICING_MAP = require('../models_pricing.json');

const modelsByProvider = { openai: [], google: [], anthropic: [] };
for (const model of Object.keys(PRICING_MAP)) {
  if (model.startsWith('gpt') || model.startsWith('o1')) modelsByProvider.openai.push(model);
  else if (model.startsWith('gemini')) modelsByProvider.google.push(model);
  else if (model.startsWith('claude')) modelsByProvider.anthropic.push(model);
}

function getTemperatureForModel(model) {
  if (model.startsWith('o1') || model.startsWith('o3')) return 1.0;
  return 0.1; // Extraction is generally low-temp
}

function generateFallbackChain(primaryProvider, primaryModel) {
  const chain = [];
  chain.push({ provider: primaryProvider, model: primaryModel });

  let primaryModels = modelsByProvider[primaryProvider] || [];
  if (primaryProvider === 'openai') {
    primaryModels = [...primaryModels].sort((a, b) => {
      if (a === 'gpt-4o') return -1;
      if (b === 'gpt-4o') return 1;
      return 0;
    });
  }

  for (const m of primaryModels) {
    if (m !== primaryModel) chain.push({ provider: primaryProvider, model: m });
  }

  const secondaryProvider = primaryProvider === 'openai' ? 'google' : 'openai';
  const secondaryModels = modelsByProvider[secondaryProvider] || [];
  for (const m of secondaryModels) chain.push({ provider: secondaryProvider, model: m });

  if (primaryProvider !== 'anthropic' && secondaryProvider !== 'anthropic') {
    const tertiaryModels = modelsByProvider.anthropic || [];
    for (const m of tertiaryModels) chain.push({ provider: 'anthropic', model: m });
  }

  return chain;
}

function parseJsonSafely(text) {
  let cleanText = text.trim();
  if (cleanText.startsWith('```')) {
    const match = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) cleanText = match[1].trim();
  }
  return JSON.parse(cleanText);
}

function calculateActualCost(model, promptTokens, completionTokens) {
  const pricing = PRICING_MAP[model];
  if (!pricing) return 0;
  return (promptTokens * pricing.input / 1000000) + (completionTokens * pricing.output / 1000000);
}

async function extractCellLLM({ prompt, jsonSchema, options = {} }) {
  const primaryProvider = options.provider || process.env.EXTRACTION_PROVIDER || 'openai';
  const primaryModel = options.model || process.env.EXTRACTION_MODEL || 'gpt-4o-mini';

  const chain = generateFallbackChain(primaryProvider, primaryModel);
  const journey = [];
  let totalCostEstimate = 0;

  for (const step of chain) {
    try {
      let result;
      if (step.provider === 'openai') {
        result = await extractWithOpenAI(prompt, jsonSchema, step.model);
      } else if (step.provider === 'google') {
        result = await extractWithGoogle(prompt, jsonSchema, step.model);
      } else if (step.provider === 'anthropic') {
        result = await extractWithAnthropic(prompt, jsonSchema, step.model);
      } else {
        journey.push(`[${step.provider}/${step.model}] Failed: Unknown provider`);
        continue;
      }

      totalCostEstimate += result.costEstimate;
      
      let parsed;
      try {
        parsed = parseJsonSafely(result.text);
      } catch (parseErr) {
        journey.push(`[${step.provider}/${step.model}] Failed: JSON Parse Error - ${parseErr.message}`);
        console.error(`[ExtractionEngine] Raw output failed to parse:`, result.text);
        continue; // Try next fallback if parsing fails
      }

      journey.push(`[${step.provider}/${step.model}] Success`);
      return {
        parsed,
        usage: result.usage,
        costEstimate: totalCostEstimate,
        journey
      };

    } catch (error) {
      journey.push(`[${step.provider}/${step.model}] Failed: ${error.message}`);
      continue;
    }
  }

  throw new Error(`All providers failed. Journey:\n  ` + journey.join('\n  '));
}

async function extractWithOpenAI(prompt, jsonSchema, model) {
  const openai = getOpenAIClient();
  const response = await openai.chat.completions.create({
    model: model,
    messages: [{ role: 'user', content: prompt }],
    response_format: {
      type: 'json_schema',
      json_schema: jsonSchema
    },
    temperature: getTemperatureForModel(model)
  });

  const text = response.choices[0]?.message?.content || '';
  const promptTokens = response.usage?.prompt_tokens || 0;
  const completionTokens = response.usage?.completion_tokens || 0;

  return {
    text,
    usage: { promptTokens, completionTokens },
    costEstimate: calculateActualCost(model, promptTokens, completionTokens)
  };
}

async function extractWithGoogle(prompt, jsonSchema, modelName) {
  const genAI = getGoogleClient();
  const model = genAI.getGenerativeModel({ 
    model: modelName,
    generationConfig: { 
      temperature: getTemperatureForModel(modelName),
      responseMimeType: "application/json"
    }
  });

  const result = await model.generateContent(prompt);
  const response = await result.response;
  const text = response.text();

  const promptTokens = response.usageMetadata?.promptTokenCount || 0;
  const completionTokens = response.usageMetadata?.candidatesTokenCount || 0;

  return {
    text,
    usage: { promptTokens, completionTokens },
    costEstimate: calculateActualCost(modelName, promptTokens, completionTokens)
  };
}

async function extractWithAnthropic(prompt, jsonSchema, modelName) {
  const anthropic = getAnthropicClient();
  
  // Instruct Anthropic to output ONLY JSON
  const systemPrompt = `You are a data extraction system. You must output ONLY valid JSON matching this schema, with no markdown formatting or other text:\n${JSON.stringify(jsonSchema, null, 2)}`;
  
  const response = await anthropic.messages.create({
    model: modelName,
    max_tokens: 4096,
    temperature: getTemperatureForModel(modelName),
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: prompt
      }
    ]
  });

  const text = response.content[0].text;
  const promptTokens = response.usage?.input_tokens || 0;
  const completionTokens = response.usage?.output_tokens || 0;

  return {
    text,
    usage: { promptTokens, completionTokens },
    costEstimate: calculateActualCost(modelName, promptTokens, completionTokens)
  };
}

module.exports = {
  extractCellLLM,
  parseJsonSafely
};
