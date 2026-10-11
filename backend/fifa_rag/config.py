from pathlib import Path

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore", populate_by_name=True)
    graph_path: Path = ROOT / "fifa_production_graphrag_db(2)"
    semantic_path: Path = ROOT / "data/semantic"
    groq_api_key: SecretStr = Field(default=SecretStr(""), validation_alias=AliasChoices("GROQ_API_KEY", "groq_api"))
    groq_model: str = "openai/gpt-oss-120b"
    groq_base_url: str = "https://api.groq.com/openai/v1"
    enable_paid_inference: bool = True
    request_timeout: float = Field(default=45, ge=1, le=120)
    graph_timeout_ms: int = Field(default=5000, ge=100, le=30000)
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)

    def resolve_paths(self) -> "Settings":
        for name in ("graph_path", "semantic_path"):
            value = getattr(self, name)
            if not value.is_absolute():
                setattr(self, name, ROOT / value)
        return self
