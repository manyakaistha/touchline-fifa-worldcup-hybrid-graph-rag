from typing import Literal

from pydantic import BaseModel, Field, field_validator

Mode = Literal["graph", "semantic", "hybrid", "auto"]

class Evidence(BaseModel):
    id: str
    text: str
    source: str
    score: float = 0
    methods: list[str] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)
    metadata: dict = Field(default_factory=dict)

class QueryRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    mode: Mode = "hybrid"
    top_k: int = Field(default=6, ge=1, le=12)
    generate: bool = False
    graph_reasoning: bool = False
    tournament: str | None = Field(default=None, max_length=100)

    @field_validator("question")
    @classmethod
    def normalize(cls, value: str) -> str:
        value = " ".join(value.split())
        if len(value) < 2:
            raise ValueError("Please enter a question with at least two characters.")
        return value

class QueryResponse(BaseModel):
    question: str
    requested_mode: Mode
    used_mode: str
    answer: str
    evidence: list[Evidence]
    diagnostics: list[str] = Field(default_factory=list)
    generation: str
    graph_query: dict | None = None
    elapsed_ms: float
    graph: dict = Field(default_factory=lambda: {"nodes": [], "edges": []})
