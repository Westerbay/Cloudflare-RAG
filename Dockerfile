FROM python:3.11.14-slim@sha256:c8271b1f627d0068857dce5b53e14a9558603b527e46f1f901722f935b786a39

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src/ ./src/
COPY database/ ./database/
COPY scripts/ ./scripts/
RUN pip install --no-cache-dir . && useradd --system --uid 10001 rag
USER rag

CMD ["uvicorn", "small_rag.api:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
