FROM python:3.13-alpine

LABEL org.opencontainers.image.title="TrueNAS Snapshot Visualizer" \
      org.opencontainers.image.description="Visualise ZFS snapshots by size and age (treemap, timeline, tables)" \
      org.opencontainers.image.licenses="MIT"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SNAPVIZ_PORT=8080

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY snapviz ./snapviz
COPY static ./static

# TrueNAS "apps" user; the app needs no write access anywhere
USER 568:568
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider "http://127.0.0.1:${SNAPVIZ_PORT}/healthz" || exit 1

CMD ["python", "-m", "snapviz"]
