FROM node:20-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860
# Run node directly (no npm wrapper) so HuggingFace SIGTERM reaches the bot and it shuts down cleanly
CMD ["node", "src/index.js"]
