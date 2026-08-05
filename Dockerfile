# Image légère, aucune dépendance npm à installer.
FROM node:20-alpine

# Bonne pratique : ne pas tourner en root.
WORKDIR /app

# On copie uniquement ce qui est nécessaire au runtime.
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Vérification de santé (utilise l'endpoint /api/health).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

USER node

CMD ["node", "server.js"]
