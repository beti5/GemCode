import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const HOST = process.env.GEMINI_PROXY_HOST || '127.0.0.1'
const PORT = Number.parseInt(process.env.GEMINI_PROXY_PORT || '11435', 10)
const GEMINI_BASE_URL = (
  process.env.GEMINI_BASE_URL ||
  'https://generativelanguage.googleapis.com/v1beta'
).replace(/\/+$/, '')
const DEFAULT_GEMINI_MODEL =
  process.env.GEMINI_PROXY_DEFAULT_MODEL || 'gemini-2.5-flash'
const LOG_FILE = 'gemini-proxy.log'
const ERR_LOG_FILE = 'gemini-proxy.err.log'
const RESOLVED_GROUNDING_URL_CACHE = new Map()

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function log(message, extra) {
  const timestamp = new Date().toISOString()
  let line
  if (extra === undefined) {
    line = `[${timestamp}] ${message}`
  } else {
    line = `[${timestamp}] ${message} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`
  }
  console.log(line)
  appendFileSync(LOG_FILE, `${line}\n`)
}

function logError(message, error) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message} ${error?.stack || error?.message || String(error)}`
  console.error(line)
  appendFileSync(ERR_LOG_FILE, `${line}\n`)
}

function getGeminiApiKey() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  if (!apiKey) {
    throw new Error(
      'Set GEMINI_API_KEY or GOOGLE_API_KEY before using the Gemini proxy.',
    )
  }
  return apiKey
}

function writeJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

function writeAnthropicError(res, statusCode, message, requestId) {
  writeJson(
    res,
    statusCode,
    {
      type: 'error',
      error: {
        type: 'api_error',
        message,
      },
      request_id: requestId,
    },
    {
      'x-request-id': requestId,
    },
  )
}

function sendSseEvent(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function normalizeToolArgs(args) {
  if (isPlainObject(args)) {
    return args
  }
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed
      }
    } catch {}
  }
  return {}
}

function summarizeToolResultContent(content) {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }

  const summarized = content.map(block => {
    if (block?.type === 'text') {
      return block.text
    }
    if (block?.type === 'image') {
      return '[image omitted]'
    }
    if (block?.type === 'document') {
      return '[document omitted]'
    }
    return JSON.stringify(block)
  })

  return summarized.join('\n\n').trim()
}

function flattenSystemPrompt(system) {
  if (!system) {
    return undefined
  }
  if (typeof system === 'string') {
    const trimmed = system.trim()
    return trimmed || undefined
  }
  if (!Array.isArray(system)) {
    return undefined
  }

  const text = system
    .map(block => {
      if (typeof block === 'string') {
        return block
      }
      if (block && typeof block === 'object' && typeof block.text === 'string') {
        return block.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()

  return text || undefined
}

function createInlineDataPart(block) {
  if (block?.source?.type !== 'base64') {
    return null
  }
  return {
    inlineData: {
      mimeType: block.source.media_type,
      data: block.source.data,
    },
  }
}

function anthropicContentToGeminiParts(role, content, toolNameById) {
  const blocks =
    typeof content === 'string' ? [{ type: 'text', text: content }] : content || []

  return blocks.flatMap(block => {
    switch (block?.type) {
      case 'text':
        return block.text ? [{ text: block.text }] : []
      case 'image':
      case 'document': {
        if (role === 'assistant') {
          return []
        }
        const inlinePart = createInlineDataPart(block)
        return inlinePart ? [inlinePart] : []
      }
      case 'tool_use':
        if (role !== 'assistant') {
          return []
        }
        toolNameById.set(block.id, block.name)
        return [
          {
            functionCall: {
              id: block.id,
              name: block.name,
              args:
                block.input && typeof block.input === 'object' && !Array.isArray(block.input)
                  ? block.input
                  : {},
            },
          },
        ]
      case 'tool_result':
        if (role !== 'user') {
          return []
        }
        return [
          {
            functionResponse: {
              id: block.tool_use_id,
              name: toolNameById.get(block.tool_use_id) || 'tool_result',
              response: {
                tool_use_id: block.tool_use_id,
                is_error: block.is_error || false,
                result: summarizeToolResultContent(block.content),
              },
            },
          },
        ]
      case 'thinking':
      case 'redacted_thinking':
        return []
      default:
        return role === 'assistant'
          ? []
          : [{ text: JSON.stringify(block) }]
    }
  })
}

function anthropicMessagesToGeminiContents(messages) {
  const toolNameById = new Map()
  const contents = []

  for (const message of messages || []) {
    const role = message.role === 'assistant' ? 'model' : 'user'
    const parts = anthropicContentToGeminiParts(
      message.role,
      message.content,
      toolNameById,
    )
    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  return contents
}

function mergeInstructionText(existingText, extraText) {
  const trimmedExisting = typeof existingText === 'string' ? existingText.trim() : ''
  const trimmedExtra = typeof extraText === 'string' ? extraText.trim() : ''

  if (!trimmedExisting) {
    return trimmedExtra || undefined
  }
  if (!trimmedExtra) {
    return trimmedExisting
  }

  return `${trimmedExisting}\n\n${trimmedExtra}`
}

function buildWebSearchInstruction(webSearch, toolChoice) {
  if (!webSearch) {
    return undefined
  }

  const instructions = [
    'Google Search grounding is available for this request through the web_search tool.',
    'If the user asks for current or recent information, use grounded Google Search instead of claiming you cannot browse.',
  ]

  if (toolChoice?.type === 'tool' && toolChoice.name === 'web_search') {
    instructions.push(
      'You must use grounded Google Search before answering this request.',
    )
  }

  if (Array.isArray(webSearch.allowed_domains) && webSearch.allowed_domains.length > 0) {
    instructions.push(
      `Prefer results only from these domains when possible: ${webSearch.allowed_domains.join(', ')}`,
    )
  }

  if (Array.isArray(webSearch.blocked_domains) && webSearch.blocked_domains.length > 0) {
    instructions.push(
      `Avoid using results from these domains when possible: ${webSearch.blocked_domains.join(', ')}`,
    )
  }

  return instructions.join('\n')
}

function parseAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return {
      geminiTools: undefined,
      functionDeclarationCount: 0,
      webSearch: null,
    }
  }

  function sanitizeSchemaForGemini(schema) {
    if (Array.isArray(schema)) {
      return schema
        .map(item => sanitizeSchemaForGemini(item))
        .filter(item => item !== undefined)
    }

    if (!schema || typeof schema !== 'object') {
      return schema
    }

    const out = {}

    for (const [key, value] of Object.entries(schema)) {
      if (
        key === '$schema' ||
        key === 'additionalProperties' ||
        key === 'propertyNames' ||
        key === 'patternProperties' ||
        key === 'unevaluatedProperties' ||
        key === 'const' ||
        key === '$defs' ||
        key === 'definitions' ||
        key === 'examples' ||
        key === 'default' ||
        key === 'title' ||
        key === 'readOnly' ||
        key === 'writeOnly'
      ) {
        continue
      }

      if (key === 'exclusiveMinimum') {
        if (typeof value === 'number' && out.minimum === undefined) {
          out.minimum = value
        }
        continue
      }

      if (key === 'exclusiveMaximum') {
        if (typeof value === 'number' && out.maximum === undefined) {
          out.maximum = value
        }
        continue
      }

      if (key === 'properties' && value && typeof value === 'object') {
        out.properties = Object.fromEntries(
          Object.entries(value)
            .map(([propKey, propValue]) => [
              propKey,
              sanitizeSchemaForGemini(propValue),
            ])
            .filter(([, propValue]) => propValue !== undefined),
        )
        continue
      }

      if (key === 'items') {
        out.items = sanitizeSchemaForGemini(value)
        continue
      }

      if (
        (key === 'anyOf' || key === 'oneOf' || key === 'allOf') &&
        Array.isArray(value)
      ) {
        const sanitizedVariants = value
          .map(item => sanitizeSchemaForGemini(item))
          .filter(item => item !== undefined)

        if (sanitizedVariants.length === 1) {
          Object.assign(out, sanitizedVariants[0])
        } else if (sanitizedVariants.length > 1) {
          out.anyOf = sanitizedVariants
        }
        continue
      }

      out[key] = sanitizeSchemaForGemini(value)
    }

    return out
  }

  const functionDeclarations = []
  let webSearch = null

  for (const tool of tools) {
    if (typeof tool?.type === 'string' && tool.type.startsWith('web_search_')) {
      webSearch = {
        name: tool.name || 'web_search',
        allowed_domains: Array.isArray(tool.allowed_domains)
          ? tool.allowed_domains.filter(domain => typeof domain === 'string')
          : undefined,
        blocked_domains: Array.isArray(tool.blocked_domains)
          ? tool.blocked_domains.filter(domain => typeof domain === 'string')
          : undefined,
        max_uses: typeof tool.max_uses === 'number' ? tool.max_uses : undefined,
      }
      continue
    }

    if (!tool?.name || !tool?.input_schema) {
      continue
    }

    functionDeclarations.push({
      name: tool.name,
      description: tool.description,
      parameters: sanitizeSchemaForGemini(tool.input_schema),
    })
  }

  const geminiTools = []
  if (functionDeclarations.length > 0) {
    geminiTools.push({ functionDeclarations })
  }
  if (webSearch) {
    geminiTools.push({ google_search: {} })
  }

  return {
    geminiTools: geminiTools.length > 0 ? geminiTools : undefined,
    functionDeclarationCount: functionDeclarations.length,
    webSearch,
  }
}

function geminiToolConfigFromAnthropic(toolChoice, parsedTools) {
  if (!toolChoice) {
    return undefined
  }
  if (
    toolChoice.type === 'tool' &&
    toolChoice.name === 'web_search' &&
    parsedTools?.webSearch
  ) {
    return undefined
  }
  if (toolChoice.type === 'tool') {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [toolChoice.name],
      },
    }
  }
  return {
    functionCallingConfig: {
      mode: 'AUTO',
    },
  }
}

function geminiGenerationConfigFromAnthropic(body) {
  const config = {}

  if (typeof body.max_tokens === 'number') {
    config.maxOutputTokens = body.max_tokens
  }
  if (typeof body.temperature === 'number') {
    config.temperature = body.temperature
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    config.stopSequences = body.stop_sequences
  }
  if (body.thinking?.type === 'enabled') {
    config.thinkingConfig = {
      thinkingBudget: body.thinking.budget_tokens,
    }
  }
  if (body.output_config?.format?.type === 'json_schema') {
    config.responseMimeType = 'application/json'
    config.responseJsonSchema = body.output_config.format.schema
  }

  return Object.keys(config).length > 0 ? config : undefined
}

function mapAnthropicModelToGemini(model) {
  if (!model) {
    return DEFAULT_GEMINI_MODEL
  }

  const normalized = String(model).toLowerCase()
  if (normalized.startsWith('gemini-')) {
    return model
  }
  if (normalized.includes('haiku')) {
    return 'gemini-2.5-flash-lite'
  }
  if (normalized.includes('opus')) {
    return 'gemini-2.5-pro'
  }
  if (normalized.includes('sonnet')) {
    return 'gemini-2.5-flash'
  }

  return DEFAULT_GEMINI_MODEL
}

function buildGeminiRequestFromAnthropic(body) {
  const contents = anthropicMessagesToGeminiContents(body.messages)
  const parsedTools = parseAnthropicTools(body.tools)
  const request = {
    contents:
      contents.length > 0
        ? contents
        : [{ role: 'user', parts: [{ text: 'Continue.' }] }],
  }

  const systemPrompt = flattenSystemPrompt(body.system)
  const webSearchInstruction = buildWebSearchInstruction(
    parsedTools.webSearch,
    body.tool_choice,
  )
  const mergedSystemPrompt = mergeInstructionText(
    systemPrompt,
    webSearchInstruction,
  )
  if (mergedSystemPrompt) {
    request.systemInstruction = {
      parts: [{ text: mergedSystemPrompt }],
    }
  }

  if (parsedTools.geminiTools) {
    request.tools = parsedTools.geminiTools
  }

  const toolConfig = geminiToolConfigFromAnthropic(
    body.tool_choice,
    parsedTools,
  )
  if (toolConfig) {
    request.toolConfig = toolConfig
  }

  const generationConfig = geminiGenerationConfigFromAnthropic(body)
  if (generationConfig) {
    request.generationConfig = generationConfig
  }

  return { request, parsedTools }
}

async function postGemini(path, body) {
  const response = await fetch(`${GEMINI_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': getGeminiApiKey(),
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  let data = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      text ||
      `${response.status} ${response.statusText}`
    const error = new Error(message)
    error.statusCode = response.status
    throw error
  }

  return { data, headers: response.headers }
}

async function resolveGroundingUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return url
  }

  if (RESOLVED_GROUNDING_URL_CACHE.has(url)) {
    return RESOLVED_GROUNDING_URL_CACHE.get(url)
  }

  let host
  try {
    host = new URL(url).host
  } catch {
    RESOLVED_GROUNDING_URL_CACHE.set(url, url)
    return url
  }

  if (host !== 'vertexaisearch.cloud.google.com') {
    RESOLVED_GROUNDING_URL_CACHE.set(url, url)
    return url
  }

  for (const method of ['HEAD', 'GET']) {
    try {
      const response = await fetch(url, {
        method,
        redirect: 'follow',
      })
      const finalUrl =
        typeof response?.url === 'string' && response.url.length > 0
          ? response.url
          : url
      if (response.body) {
        try {
          await response.body.cancel()
        } catch {}
      }
      RESOLVED_GROUNDING_URL_CACHE.set(url, finalUrl)
      return finalUrl
    } catch {}
  }

  RESOLVED_GROUNDING_URL_CACHE.set(url, url)
  return url
}

async function getGroundingInfo(candidate) {
  const metadata = candidate?.groundingMetadata
  const queries = Array.isArray(metadata?.webSearchQueries)
    ? metadata.webSearchQueries.filter(query => typeof query === 'string')
    : []
  const hits = []
  const seenUrls = new Set()

  if (Array.isArray(metadata?.groundingChunks)) {
    for (const chunk of metadata.groundingChunks) {
      const url = chunk?.web?.uri
      if (typeof url !== 'string' || seenUrls.has(url)) {
        continue
      }

      seenUrls.add(url)
      hits.push({
        title:
          typeof chunk?.web?.title === 'string' && chunk.web.title.trim().length > 0
            ? chunk.web.title.trim()
            : url,
        url,
      })
    }
  }

  const resolvedHits = await Promise.all(
    hits.map(async hit => ({
      ...hit,
      url: await resolveGroundingUrl(hit.url),
    })),
  )

  return { queries, hits: resolvedHits }
}

function geminiUsageToAnthropicUsage(usageMetadata, webSearchRequests = 0) {
  return {
    input_tokens: usageMetadata?.promptTokenCount || 0,
    output_tokens: usageMetadata?.candidatesTokenCount || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: {
      web_search_requests: webSearchRequests,
      web_fetch_requests: 0,
    },
    service_tier: 'standard',
  }
}

async function geminiCandidateToAnthropicContent(candidate, parsedTools) {
  const parts = candidate?.content?.parts || []
  const content = []
  const groundingInfo = await getGroundingInfo(candidate)

  if (
    parsedTools?.webSearch &&
    (groundingInfo.queries.length > 0 || groundingInfo.hits.length > 0)
  ) {
    const toolUseId = `srvtoolu_${randomUUID()}`
    const toolInput = {}
    const firstQuery = groundingInfo.queries[0]

    if (firstQuery) {
      toolInput.query = firstQuery
    }
    if (
      Array.isArray(parsedTools.webSearch.allowed_domains) &&
      parsedTools.webSearch.allowed_domains.length > 0
    ) {
      toolInput.allowed_domains = parsedTools.webSearch.allowed_domains
    }
    if (
      Array.isArray(parsedTools.webSearch.blocked_domains) &&
      parsedTools.webSearch.blocked_domains.length > 0
    ) {
      toolInput.blocked_domains = parsedTools.webSearch.blocked_domains
    }

    content.push({
      type: 'server_tool_use',
      id: toolUseId,
      name: parsedTools.webSearch.name || 'web_search',
      input: toolInput,
    })
    content.push({
      type: 'web_search_tool_result',
      tool_use_id: toolUseId,
      content: groundingInfo.hits,
    })
  }

  for (const part of parts) {
    if (typeof part.text === 'string' && part.text.length > 0) {
      content.push({
        type: 'text',
        text: part.text,
      })
    }
    if (part.functionCall?.name) {
      content.push({
        type: 'tool_use',
        id: part.functionCall.id || randomUUID(),
        name: part.functionCall.name,
        input: normalizeToolArgs(part.functionCall.args),
      })
    }
  }

  if (content.length === 0) {
    content.push({
      type: 'text',
      text: '',
    })
  }

  return { content, groundingInfo }
}

function mapFinishReason(candidate, content) {
  if (candidate?.finishReason === 'MAX_TOKENS') {
    return 'max_tokens'
  }
  return content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn'
}

async function buildAnthropicMessage({
  requestedModel,
  geminiModel,
  geminiResponse,
  requestId,
  parsedTools,
}) {
  const candidate = geminiResponse?.candidates?.[0]
  if (!candidate) {
    const message =
      geminiResponse?.promptFeedback?.blockReasonMessage ||
      geminiResponse?.promptFeedback?.blockReason ||
      'Gemini returned no candidates.'
    throw new Error(message)
  }

  const { content, groundingInfo } = await geminiCandidateToAnthropicContent(
    candidate,
    parsedTools,
  )
  const webSearchRequests =
    groundingInfo.queries.length > 0
      ? groundingInfo.queries.length
      : groundingInfo.hits.length > 0 && parsedTools?.webSearch
        ? 1
        : 0
  const usage = geminiUsageToAnthropicUsage(
    geminiResponse.usageMetadata,
    webSearchRequests,
  )
  const stopReason = mapFinishReason(candidate, content)

  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: geminiModel || requestedModel || DEFAULT_GEMINI_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
    _request_id: requestId,
  }
}

function streamAnthropicMessage(res, message, requestId) {
  const inputUsage = {
    input_tokens: message.usage.input_tokens,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-request-id': requestId,
  })

  sendSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: message.id,
      type: 'message',
      role: 'assistant',
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: inputUsage,
    },
  })

  message.content.forEach((block, index) => {
    if (block.type === 'server_tool_use') {
      sendSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'server_tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      })
      if (isPlainObject(block.input) && Object.keys(block.input).length > 0) {
        sendSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(block.input),
          },
        })
      }
      sendSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      })
      return
    }

    if (block.type === 'web_search_tool_result') {
      sendSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: block.tool_use_id,
          content: Array.isArray(block.content) ? block.content : [],
        },
      })
      sendSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      })
      return
    }

    if (block.type === 'text') {
      sendSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'text',
          text: '',
        },
      })
      if (block.text) {
        sendSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'text_delta',
            text: block.text,
          },
        })
      }
      sendSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      })
      return
    }

    if (block.type === 'tool_use') {
      sendSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      })
      sendSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input || {}),
        },
      })
      sendSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      })
    }
  })

  sendSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null,
    },
    usage: {
      input_tokens: 0,
      output_tokens: message.usage.output_tokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })

  sendSseEvent(res, 'message_stop', {
    type: 'message_stop',
  })

  res.end()
}

async function handleMessages(req, res, body) {
  const requestId = `req_${randomUUID()}`
  const requestedModel = body.model
  const geminiModel = mapAnthropicModelToGemini(requestedModel)
  const { request: geminiRequest, parsedTools } = buildGeminiRequestFromAnthropic(body)
  log(`messages request -> ${geminiModel}`, {
    functionDeclarations: parsedTools.functionDeclarationCount,
    googleSearch: Boolean(parsedTools.webSearch),
  })

  try {
    const { data } = await postGemini(
      `/models/${encodeURIComponent(geminiModel)}:generateContent`,
      geminiRequest,
    )
    const message = await buildAnthropicMessage({
      requestedModel,
      geminiModel,
      geminiResponse: data,
      requestId,
      parsedTools,
    })

    if (body.stream) {
      streamAnthropicMessage(res, message, requestId)
      return
    }

    writeJson(res, 200, message, {
      'x-request-id': requestId,
    })
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500
    log(`messages error`, error?.message || String(error))
    writeAnthropicError(res, statusCode, error?.message || String(error), requestId)
  }
}

async function handleCountTokens(req, res, body) {
  const requestId = `req_${randomUUID()}`
  const requestedModel = body.model
  const geminiModel = mapAnthropicModelToGemini(requestedModel)
  log(`count_tokens request -> ${geminiModel}`)

  try {
    const { request: geminiRequest } = buildGeminiRequestFromAnthropic(body)
    const { data } = await postGemini(
      `/models/${encodeURIComponent(geminiModel)}:countTokens`,
      {
        generateContentRequest: geminiRequest,
      },
    )

    writeJson(
      res,
      200,
      {
        input_tokens: data.totalTokens || 0,
      },
      {
        'x-request-id': requestId,
      },
    )
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500
    log(`count_tokens error`, error?.message || String(error))
    writeAnthropicError(res, statusCode, error?.message || String(error), requestId)
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, {
      ok: true,
      provider: 'gemini',
      geminiKeyPresent: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      defaultModel: DEFAULT_GEMINI_MODEL,
    })
    return
  }

  log(`request ${req.method} ${url.pathname}`)

  if (req.method !== 'POST') {
    writeJson(res, 404, { error: 'Not found' })
    return
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    writeAnthropicError(
      res,
      400,
      `Invalid JSON body: ${error?.message || String(error)}`,
      `req_${randomUUID()}`,
    )
    return
  }

  if (url.pathname === '/v1/messages') {
    await handleMessages(req, res, body)
    return
  }

  if (
    url.pathname === '/v1/messages/count_tokens' ||
    url.pathname === '/v1/messages/countTokens'
  ) {
    await handleCountTokens(req, res, body)
    return
  }

  writeJson(res, 404, { error: 'Not found' })
})

server.listen(PORT, HOST, () => {
  log(`Gemini Anthropic proxy listening on http://${HOST}:${PORT}`)
})

server.on('error', error => {
  logError('proxy server error', error)
  process.exit(1)
})

process.on('unhandledRejection', error => {
  logError('unhandled rejection', error)
})

process.on('uncaughtException', error => {
  logError('uncaught exception', error)
  process.exit(1)
})
