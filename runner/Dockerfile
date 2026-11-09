FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends libseccomp2 fontconfig fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends libcairo2 curl git ffmpeg && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends iptables && rm -rf /var/lib/apt/lists/*
ARG PYPI_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
RUN pip install --no-cache-dir --timeout 120 --retries 6 --index-url="$PYPI_INDEX_URL" Pillow==11.3.0 CairoSVG==2.8.2 requests
RUN pip install --no-cache-dir --timeout 120 --retries 6 --index-url="$PYPI_INDEX_URL" jmcomic==2.7.11 img2pdf==0.6.3 "pypdf[crypto]==7.0.0"
WORKDIR /runner
COPY server.py sandbox.py entrypoint.sh /runner/
RUN sed -i 's/\r$//' /runner/entrypoint.sh
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8766
CMD ["sh", "/runner/entrypoint.sh"]
