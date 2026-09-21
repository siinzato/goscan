FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .

# Variáveis VITE_* precisam existir NO MOMENTO do build — o Vite as grava
# dentro do JS gerado (não são lidas em runtime pelo servidor).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

RUN npm run build

ENV NODE_ENV=production
EXPOSE 8788

CMD ["node", "run-local.mjs"]
