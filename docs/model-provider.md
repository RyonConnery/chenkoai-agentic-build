# Model Provider Abstraction

ChenkoAI routes model calls through a provider adapter so product workflows are not hardcoded to one LLM vendor.

## Providers

```text
MODEL_PROVIDER=mock
MODEL_PROVIDER=openai-compatible
MODEL_PROVIDER=local-http
```

## API

```text
GET  /model/provider
POST /model/generate
```

Example request:

```json
{
  "systemPrompt": "You are ChenkoAI.",
  "prompt": "Create a short plan for the next build step.",
  "temperature": 0.2,
  "maxTokens": 512
}
```

## Mock Provider

The mock provider is the default. It requires no API keys and exists so the agent runtime can be developed and tested without spending tokens or depending on network access.

## OpenAI-Compatible Provider

```powershell
$env:MODEL_PROVIDER="openai-compatible"
$env:OPENAI_API_KEY="..."
$env:OPENAI_BASE_URL="https://api.openai.com/v1"
$env:OPENAI_MODEL="gpt-4.1-mini"
```

This adapter targets `/chat/completions` so it can also work with other OpenAI-compatible gateways later.

## Local HTTP Provider

```powershell
$env:MODEL_PROVIDER="local-http"
$env:LOCAL_LLM_BASE_URL="http://localhost:11434"
$env:LOCAL_LLM_MODEL="llama3.2:3b"
```

The local adapter currently targets an Ollama-style `/api/generate` endpoint.
