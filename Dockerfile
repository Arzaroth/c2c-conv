FROM node:24-bookworm-slim

ARG UID=1000
ARG GID=1000

# git is for claude and for c2c --version. cloudflared comes from Cloudflare's
# own release so it lands on PATH, which is where c2c looks first.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tmux \
 && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb" -o /tmp/cloudflared.deb \
 && dpkg -i /tmp/cloudflared.deb \
 && rm /tmp/cloudflared.deb \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# The bind mounts have to be writable by whoever runs inside, so the image
# user takes the host user's ids at build time.
RUN userdel -r node \
 && groupadd -g "$GID" c2c \
 && useradd -m -u "$UID" -g "$GID" -s /bin/bash c2c

COPY --chown=c2c:c2c . /opt/c2c-conv
RUN ln -s /opt/c2c-conv/src/cli.js /usr/local/bin/c2c \
 && chmod +x /opt/c2c-conv/src/cli.js /opt/c2c-conv/docker/entrypoint.sh

USER c2c
ENV HOME=/home/c2c USER=c2c CLAUDE_CODE_TMPDIR=/home/c2c/.cache/claude
RUN mkdir -p /home/c2c/.cache/claude
WORKDIR /home/c2c

EXPOSE 7331
ENTRYPOINT ["/opt/c2c-conv/docker/entrypoint.sh"]
CMD ["--tunnel"]
