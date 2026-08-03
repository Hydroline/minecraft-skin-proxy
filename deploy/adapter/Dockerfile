FROM node:24-bookworm-slim

WORKDIR /app

COPY src /app/src

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "/app/src/server.js"]
