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

# TrueNAS "apps" user; the app needs no write access (optional SNAPVIZ_DATA_DIR keeps the certificate)
USER 568:568
EXPOSE 8080

# python instead of busybox wget, which cannot do https
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["python", "-m", "snapviz.healthcheck"]

CMD ["python", "-m", "snapviz"]
