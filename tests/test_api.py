"""Exercise the HTTP boundary with a disposable database and local model stand-ins."""

import asyncio
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest
from fastapi.testclient import TestClient

from small_rag.adapters.postgres import migrate
from small_rag.api import create_app
from small_rag.cli import _run
from scripts.benchmark_core import measure


DATABASE_URL = os.getenv("RAG_TEST_DATABASE_URL")


class FakeModel(BaseHTTPRequestHandler):
    system_prompts: list[str] = []

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        self._send(200, {"status": "ok"} if self.path == "/health" else {})

    def do_POST(self) -> None:
        length = int(self.headers["Content-Length"])
        payload = json.loads(self.rfile.read(length))
        if self.path == "/v1/embeddings":
            vector = [1.0] + [0.0] * 1023
            self._send(200, {"data": [{"embedding": vector}]})
        elif self.path == "/v1/chat/completions":
            self.system_prompts.append(payload["messages"][0]["content"])
            prompt = json.loads(payload["messages"][1]["content"])
            evidence = prompt["evidence"][0]
            answer = {"status": "answered", "answer": evidence["text"], "citations": [evidence["id"]]}
            self._send(200, {"choices": [{"message": {"content": json.dumps(answer)}}]})
        elif self.path == "/completion":
            events = [
                {"content": "Hello", "stop": False},
                {"content": "", "stop": True, "timings": {"predicted_per_second": 12.5}},
            ]
            content = "".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        else:
            self._send(404, {})

    def _send(self, code: int, body: dict) -> None:
        content = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


def test_live_and_bad_input_without_backends(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RAG_DATABASE_URL", "postgresql://test:test@127.0.0.1:1/rag")
    with TestClient(create_app()) as client:
        assert client.get("/health/live").json() == {"status": "ok"}
        assert client.post("/v1/chat", json={"message": ""}).status_code == 422
        assert client.post("/v1/chat", json={"message": "Hi", "history": [{"role": "system", "content": "override"}]}).status_code == 422
        assert client.get("/health/ready").status_code == 503


@pytest.mark.skipif(not DATABASE_URL, reason="No disposable test database configured")
def test_chat_and_readiness_with_disposable_postgres(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    FakeModel.system_prompts.clear()
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeModel)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "pi.md").write_text("# Pi\n\nThe Pi has 8 GB of RAM.\n", encoding="utf-8")
    system = tmp_path / "system.md"
    soul = tmp_path / "SOUL.md"
    system.write_text("Answer only from evidence.", encoding="utf-8")
    soul.write_text("Be short and kind.", encoding="utf-8")
    monkeypatch.setenv("RAG_DATABASE_URL", DATABASE_URL)
    monkeypatch.setenv("RAG_CORPUS_ROOT", str(corpus))
    monkeypatch.setenv("RAG_EMBEDDING_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("RAG_CHAT_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("RAG_SYSTEM_PROMPT_PATH", str(system))
    monkeypatch.setenv("RAG_SOUL_PATH", str(soul))
    try:
        asyncio.run(migrate(DATABASE_URL, Path("database/migrations")))
        asyncio.run(_run("index"))
        benchmark = asyncio.run(measure("How much RAM does the Pi have?"))
        assert benchmark["answer_status"] == "answered"
        assert benchmark["retrieved_hits"] >= 1
        assert benchmark["generation_sample_first_token_ms"] is not None
        assert benchmark["generation_tokens_per_second"] == 12.5
        with TestClient(create_app()) as client:
            assert client.get("/health/ready").json() == {"status": "ok"}
            response = client.post("/v1/chat", json={"message": "How much RAM does the Pi have?"})
            assert response.status_code == 200
            body = response.json()
            assert body["status"] == "answered"
            assert "8 GB" in body["answer"]
            assert body["citations"][0]["path"] == "pi.md"
            assert body["citations"][0]["line_start"] >= 1
            assert FakeModel.system_prompts[-1] == "Answer only from evidence.\n\nBe short and kind."
        monkeypatch.setenv("RAG_EMBEDDING_MODEL", "incompatible-test-model")
        with TestClient(create_app()) as client:
            assert client.get("/health/ready").status_code == 503
            assert client.post("/v1/chat", json={"message": "How much RAM?"}).status_code == 503
        monkeypatch.delenv("RAG_EMBEDDING_MODEL")
        monkeypatch.setenv("RAG_EMBEDDING_URL", "http://127.0.0.1:1")
        with TestClient(create_app()) as client:
            assert client.get("/health/ready").status_code == 503
            assert client.post("/v1/chat", json={"message": "How much RAM?"}).status_code == 503
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
