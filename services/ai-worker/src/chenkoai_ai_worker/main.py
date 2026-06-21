from pydantic import BaseModel
from fastapi import FastAPI


class EmbedRequest(BaseModel):
    text: str


app = FastAPI(title="ChenkoAI AI Worker")


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {"ok": True, "service": "chenkoai-ai-worker"}


@app.post("/embeddings")
def create_embedding(request: EmbedRequest) -> dict[str, object]:
    # Placeholder until the model provider abstraction is wired in.
    return {
        "text": request.text,
        "embedding": [],
        "model": "not-configured",
    }

