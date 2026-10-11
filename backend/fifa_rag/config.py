from pathlib import Path
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")
    graph_path: Path = ROOT / "fifa_production_graphrag_db(2)"
    semantic_path: Path = ROOT / "data/semantic"
    xai_api_key: SecretStr = SecretStr("")
    xai_model: str = "grok-4.3"
    xai_base_url: str = "https://api.x.ai/v1"
    enable_paid_inference: bool = False
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
