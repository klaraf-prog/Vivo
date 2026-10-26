FROM mcr.microsoft.com/devcontainers/javascript-node:22

# Java 21 JRE — required by Firebase Auth + RTDB emulators.
# openjdk-21-jre-headless is available in Debian Bookworm (the base of node:22).
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-21-jre-headless \
    && rm -rf /var/lib/apt/lists/*
