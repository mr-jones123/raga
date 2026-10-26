ARG TASK_IMAGE
FROM ${TASK_IMAGE}
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap=0.8.0-2+deb12u1 \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/raga-python \
    && /opt/raga-python/bin/python -m pip install --no-cache-dir dill==0.4.0
# Copy the module cache where bubblewrap's read-only /usr mount already exposes it, then set the
# offline defaults in GOROOT/go.env so both arms get identical behavior without wrapper scripts.
RUN mkdir -p /usr/local/share/raga-go-mod \
    && cp -a "$(go env GOMODCACHE)/." /usr/local/share/raga-go-mod/ \
    && printf 'GOMODCACHE=/usr/local/share/raga-go-mod\nGOPATH=/app/.gopath\nGOPROXY=off\nGOSUMDB=off\nGOTOOLCHAIN=local\n' >> "$(go env GOROOT)/go.env"
ENV RAGA_PYTHON=/opt/raga-python/bin/python
ENV PI_OFFLINE=1
WORKDIR /app
