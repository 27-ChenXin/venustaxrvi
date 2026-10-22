# ─────────────────────────────────────────────────────────────────
# ASA AI Dream Machine (cosplay/party kiosk) – Cloud Dockerfile
# Ubuntu 24.04 + Python 3.12 + FastAPI/uvicorn on port 10003
# ─────────────────────────────────────────────────────────────────
FROM ubuntu:24.04
WORKDIR /app

# System packages (python3.12 ships with Ubuntu 24.04)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3.12 \
       python3.12-venv \
       python3-pip \
       libgl1 \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY server-code/requirements.txt /app/requirements.txt
RUN python3.12 -m pip install --no-cache-dir --break-system-packages -r requirements.txt

# Application code
COPY server-code/ /app/
COPY web-app/ /app/web-app/

# Cosplay reference & background images (read-only; served at /imgs/)
COPY imgs/ /app/imgs/

# Writable runtime dirs (fallback when /var/data persistent disk is not mounted)
RUN mkdir -p /app/uploads /app/gallery

EXPOSE 10003

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD python3.12 -c "import urllib.request; urllib.request.urlopen('http://localhost:10003/health')"

CMD ["python3.12", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "10003"]
