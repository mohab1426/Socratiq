# SocratiQ API image (FastAPI + in-process ingestion worker). Build context = repository root.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

# libpq for psycopg; libgl1/libglib for the OCR engine's OpenCV dependency
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-ai.txt ./
RUN pip install -r requirements.txt

COPY ai ./ai
COPY backend ./backend
COPY database ./database
COPY scripts ./scripts

# never run as root
RUN useradd --create-home --uid 10001 app && mkdir -p /app/data/uploads && chown -R app /app/data
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://localhost:8000/health || exit 1
CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers"]